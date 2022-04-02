process.env.INGESTER_AUTHOR = 'opl';

import {Buffer} from 'buffer';
import https from 'https';
import {AmqpSink, AmqpTap, FileSink, getGlobalAuthor, NewData, Pipe, setGlobalAuthor} from 'ingester';
import fetch from 'node-fetch';
import Jimp from 'jimp';

const COOKIES = 'token_v2=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2NDg4MjM0MTQsInN1YiI6IjM2OTY3ODQ5LUtPVS1MMU9nY3ZQQU1iakZwdkVDYlNiclI1NUY1ZyIsImxvZ2dlZEluIjp0cnVlLCJzY29wZXMiOlsiKiIsImVtYWlsIiwicGlpIl19.B7lEO7V6Vay8YCPIV1vgyYjlBeYuybKPFneCU7n4V6A; csv=2; edgebucket=ha5No9Bt6seRuZXaRQ; loid=0000000000000m0ckp.2.1425914398495.Z0FBQUFBQmlST0l0NkprOUJXVk5fQ0tTM0Rxd3VMRlUwVThhenZicmtfdFJJak1LeGt4M2FLVTQ2bUYxNGkySUx5WEpOTmxKcGJGRDVFUEpVSzlRWE5icmk5MU9QU0cxZzQ3UGFBQmhQRHM2bGh3aDZ0T2JITWZleWtwU0lsaFVOR2NIeGQzaG1CWjA; reddit_session=36967849%2C2022-03-30T23%3A05%3A16%2C0bb4a57fba8f8b06ef9f4dc84d62b8e82af4ad3f; redesign_optout=true; pc=mo; session_tracker=F2u2AgOqDieUvjRRj2.0.1648820382348.Z0FBQUFBQmlSd0NlRUhzTUo3OU5WVnZ3QWQ0YjZHNG5oLVZTcGF4aEpsdUw5X0EtdjNYU05NYmRYNnBXUklXaDVMV05ZemZBakVmaXV6UERIZlRMZ0Z4T09YbC16MXhiV3d3dzNKcFFLbzd0N3dYdkpweHZBejFZVHhnbHctQWVXdnVTc2x4UUNUWnM';
const CANVAS_INDEX = 0;

// FIXME: author name gets set to hostname in websocket tap
setGlobalAuthor('opl');

function getToken(): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		https.get({
			protocol: 'https:',
			hostname: 'new.reddit.com',
			pathname: '/r/place',
			headers: {
				Cookie: COOKIES,
			},
		}, (res) => {
			if (res.statusCode !== 200) return void reject('http' + res.statusCode);

			const body: Buffer[] = [];
			res.on('data', (d) => body.push(d));

			res.on('end', () => {
				const fullBody = Buffer.concat(body).toString('utf8');

				// "session":{"accessToken":"36967849-KOU-L1OgcvPAMbjFpvECbSbrR55F5g","expires":"2022-04-01T14:30:14.000Z","expiresIn":3031952,"unsafeLoggedOut":false,"safe":true}
				const token = /"accessToken":"([^"]+)"/.exec(fullBody);
				if (token) return void resolve(token[1]);

				return void reject('noToken');
			});

			res.on('error', (err) => {
				return void reject(err);
			});
		});
	}).catch((err) => {
		console.error('getToken', err);
		return Promise.reject(err);
	});
}

let token: Promise<string> = getToken();

setInterval(() => {
	token = getToken();
}, 20 * 60000);

export interface PixelBatch {
	promise: Promise<void>;
	resolve: (_: void) => void;
	reject: (err: any) => void;
	failures: number;
	pixels: PixelRequest[];
}

export interface PixelRequest {
	x: number;
	y: number;
	canvasIndex: number;
}

(async () => {
	const batchQueue: PixelBatch[] = [];

	async function queryPixelHistory(pixels: PixelRequest[]): Promise<Buffer> {
		// Deduplicate
		pixels = pixels.filter((pixel, index, arr) => arr.slice(index + 1).findIndex((other) => pixel.x === other.x && pixel.y === other.y) === -1);

		const query = `
mutation pixelHistory(${pixels.map((pixel) => `$p${pixel.x}x${pixel.y}: ActInput!`).join(', ')}) {
${pixels.map((pixel) => `  p${pixel.x}x${pixel.y}: act(input: $p${pixel.x}x${pixel.y}) {
    data {
      ... on BasicMessage {
        id
        data {
          ... on GetTileHistoryResponseMessageData {
            lastModifiedTimestamp
            userInfo {
              userID
              username
            }
          }
        }
      }
    }
  }`).join('\n')}
}
`;

		const vars = pixels.map((pixel) => [`p${pixel.x}x${pixel.y}`, {
			actionName: "r/replace:get_tile_history",
			PixelMessageData: {
				coordinate: {
					x: pixel.x,
					y: pixel.y,
				},
				colorIndex: 0,
				canvasIndex: pixel.canvasIndex,
			},
		}]);

		const data = {
			operationName: 'pixelHistory',
			variables: Object.fromEntries(vars),
			query,
		};

		const response = await fetch('https://gql-realtime-2.reddit.com/query', {
			method: 'post',
			body: JSON.stringify(data),
			headers: {
				Authorization: `Bearer ${await token}`,
				'Content-Type': 'application/json',
				'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:88.0) Gecko/20100101 Firefox/88.0',
			},
		});

		if (!response.ok) {
			require('fs').writeFileSync('./request.log', JSON.stringify(data) + '\n' + (await response.text()));
			console.log(response);
			throw new Error('fetch response not ok');
		}

		return Buffer.from(await response.arrayBuffer());
	}

	/**
	 * Retrieve the next batch.
	 */
	async function nextBatch2() {
		const batches: PixelBatch[] = [];
		let totalPixels = 0;
		while (batchQueue.length > 0 && (batches.length === 0 || (totalPixels + batchQueue[0].pixels.length) < 5000)) {
			batches.push(batchQueue.shift()!);
		}
		if (batches.length === 0) return;

		const pixels: PixelRequest[] = batches.flatMap((batch) => batch.pixels);

		try {
			const response = await queryPixelHistory(pixels);

			pipe.giveExact({
				source: 'place2.details',
				author: getGlobalAuthor(),
				timestamp: Date.now(),
				content: response,
			});

			batches.forEach((batch) => batch.resolve());
		} catch (ex) {
			// Requeue
			batches.forEach((batch) => {
				batch.failures++;

				if (batch.failures >= 3) {
					batch.reject(ex);
				} else {
					batchQueue.push(batch);
				}
			});
		}
	}

	async function createBatch(pixels: PixelRequest[]): Promise<void> {
		let batchResolve: (_: void) => void;
		let batchReject: (err: any) => void;
		const promise = new Promise<void>((resolve, reject) => {
			batchResolve = resolve;
			batchReject = reject;
		});

		batchQueue.push({
			promise,
			resolve: batchResolve!,
			reject: batchReject!,
			failures: 0,
			pixels,
		});

		return promise;
	}
/* 
	let queuedRequests: PixelRequest[] = [];
	let batchTimeout: ReturnType<typeof setTimeout> | null = null;
	let batchResolve: (x: void) => void;
	let batchReject: (err: any) => void;
	let batchPromise: Promise<void>;

	nextBatchPromise();

	function nextBatchPromise() {
		console.log('nextBatchPromise')
		batchPromise = new Promise((resolve, reject) => {
			batchResolve = resolve;
			batchReject = reject;
		});
	}

	function requestPixelHistory(pixels: PixelRequest[]): Promise<void> {
		console.log('requestPixelHistory ' + pixels.length + ' ' + queuedRequests.length);
		queuedRequests = queuedRequests.concat(pixels);

		return batchPromise;
	}

	async function nextBatch() {
		console.log('nextBatch ' + queuedRequests.length);
		let pixels = queuedRequests.splice(0);

		const resolve = batchResolve;
		const reject = batchReject;

		if (pixels.length === 0) {
			return void resolve();
		}

		nextBatchPromise();

		// Deduplicate
		pixels = pixels.filter((pixel, index, arr) => arr.slice(index + 1).findIndex((other) => pixel.x === other.x && pixel.y === other.y) === -1);

		const query = `
mutation pixelHistory(${pixels.map((pixel) => `$p${pixel.x}x${pixel.y}: ActInput!`).join(', ')}) {
${pixels.map((pixel) => `  p${pixel.x}x${pixel.y}: act(input: $p${pixel.x}x${pixel.y}) {
    data {
      ... on BasicMessage {
        id
        data {
          ... on GetTileHistoryResponseMessageData {
            lastModifiedTimestamp
            userInfo {
              userID
              username
            }
          }
        }
      }
    }
  }`).join('\n')}
}
`;

		const vars = pixels.map((pixel) => [`p${pixel.x}x${pixel.y}`, {
			actionName: "r/replace:get_tile_history",
			PixelMessageData: {
				coordinate: {
					x: pixel.x,
					y: pixel.y,
				},
				colorIndex: 0,
				canvasIndex: pixel.canvasIndex,
			},
		}]);

		const data = {
			operationName: 'pixelHistory',
			variables: Object.fromEntries(vars),
			query,
		};

		try {
			const response = await fetch('https://gql-realtime-2.reddit.com/query', {
				method: 'post',
				body: JSON.stringify(data),
				headers: {
					Authorization: `Bearer ${await token}`,
					'Content-Type': 'application/json',
					'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:88.0) Gecko/20100101 Firefox/88.0',
				},
			});

			if (!response.ok) {
				require('fs').writeFileSync('./request.log', JSON.stringify(data) + '\n' + (await response.text()));
				console.log(response);
				throw new Error('fetch response not ok');
			}

			pipe.giveExact({
				source: 'place2.details',
				author: getGlobalAuthor(),
				timestamp: Date.now(),
				content: Buffer.from(await response.arrayBuffer()),
			});

			queuedRequests.splice(0);

			resolve();
		} catch (ex) {
			reject(ex);
		}
	} */

	setInterval(async () => {
		nextBatch2();
	}, 500);

	const pipe = new Pipe();

	const fileSink = new FileSink({
		path: '/home/opl/place2/data/details-$t.csv',
		mode: 'string',
	});
	const amqpSink = new AmqpSink({
		hostname: 'localhost',
		vhost: '/',
		username: 'place2',
		password: 'OQvT2GLnludwuFmKyrARMLy9',
		exchange: 'place2',
		routingKeyPrefix: 'details.',
	});

	await fileSink.enable();
	await amqpSink.enable();

	pipe.connectSink(fileSink);
	pipe.connectSink(amqpSink);

	// ---

	const amqpIn = new AmqpTap({
		name: 'pixelColor',
		hostname: 'localhost',
		vhost: '/',
		username: 'place2',
		password: 'OQvT2GLnludwuFmKyrARMLy9',
		async createQueue(channel): Promise<string> {
			await channel.assertExchange('place2', 'topic', {
				durable: true,
				autoDelete: false,
			});

			await channel.assertQueue('place2.canvasPngDetails', {
				durable: true,
			});

			await channel.bindQueue('place2.canvasPngDetails', 'place2', 'canvasPng.*');

			// Limit to processing a few messages at a time
			await channel.prefetch(10);

			return 'place2.canvasPngDetails';
		},
		async transform(data): Promise<NewData | null> {
			if (data.content === null) {
				console.error('data has null content!', data);
				return null;
			}

			const canvasIndex = parseInt((/^canvasDownloader\.(\d+)/.exec(data.source) ?? ['0', '0'])[1]);

			let image: Jimp;
			try {
				image = await Jimp.read(data.content);
			} catch (ex) {
				if (ex.message === 'Could not find MIME for Buffer <null>') {
					console.error(ex, data);
					return null;
				}

				throw ex;
			}
			const pixels: PixelRequest[] = [];
			const announce: NewData[] = [];

			for (let y = 0; y < image.bitmap.height; y++) {
				for (let x = 0; x < image.bitmap.width; x++) {
					const pixelIndex = (image.bitmap.width * y + x) << 2;
					const color = image.bitmap.data.readUInt32BE(pixelIndex);

					if (color > 0) {
						// Request history information from Reddit
						pixels.push({
							x,
							y,
							canvasIndex,
						});

						// But also announce the pixel change
						announce.push({
							timestamp: data.timestamp,
							content: Buffer.from(JSON.stringify({
								x,
								y,
								color,
							})),
						});
					}
				}
			}

			await createBatch(pixels);

			// Announce after request to prevent duplicates
			announce.forEach((data) => {
				amqpIn.give(data);
			});

			return null;
		},
	});

	const pixelsFileSink = new FileSink({
		path: '/home/opl/place2/data/pixels-$t.csv',
		mode: 'string',
	});
	const pixelsAmqpSink = new AmqpSink({
		hostname: 'localhost',
		vhost: '/',
		username: 'place2',
		password: 'OQvT2GLnludwuFmKyrARMLy9',
		exchange: 'place2',
		routingKeyPrefix: 'pixels.',
	});

	await pixelsFileSink.enable();
	await pixelsAmqpSink.enable();

	const pixelsPipe = new Pipe();

	pixelsPipe.connectSink(pixelsFileSink);
	pixelsPipe.connectSink(pixelsAmqpSink);

	amqpIn.connectSink(pixelsPipe);

	// ---

	await amqpIn.enable();
})();
