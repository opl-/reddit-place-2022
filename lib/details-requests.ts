process.env.INGESTER_AUTHOR = 'opl';

import {Buffer} from 'buffer';
import https from 'https';
import {AmqpSink, AmqpTap, FileSink, getGlobalAuthor, NewData, Pipe, setGlobalAuthor} from 'ingester';
import fetch from 'node-fetch';

const COOKIES = 'token_v2=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2NDg4MjM0MTQsInN1YiI6IjM2OTY3ODQ5LUtPVS1MMU9nY3ZQQU1iakZwdkVDYlNiclI1NUY1ZyIsImxvZ2dlZEluIjp0cnVlLCJzY29wZXMiOlsiKiIsImVtYWlsIiwicGlpIl19.B7lEO7V6Vay8YCPIV1vgyYjlBeYuybKPFneCU7n4V6A; csv=2; edgebucket=ha5No9Bt6seRuZXaRQ; loid=0000000000000m0ckp.2.1425914398495.Z0FBQUFBQmlST0l0NkprOUJXVk5fQ0tTM0Rxd3VMRlUwVThhenZicmtfdFJJak1LeGt4M2FLVTQ2bUYxNGkySUx5WEpOTmxKcGJGRDVFUEpVSzlRWE5icmk5MU9QU0cxZzQ3UGFBQmhQRHM2bGh3aDZ0T2JITWZleWtwU0lsaFVOR2NIeGQzaG1CWjA; reddit_session=36967849%2C2022-03-30T23%3A05%3A16%2C0bb4a57fba8f8b06ef9f4dc84d62b8e82af4ad3f; redesign_optout=true; pc=mo; session_tracker=F2u2AgOqDieUvjRRj2.0.1648820382348.Z0FBQUFBQmlSd0NlRUhzTUo3OU5WVnZ3QWQ0YjZHNG5oLVZTcGF4aEpsdUw5X0EtdjNYU05NYmRYNnBXUklXaDVMV05ZemZBakVmaXV6UERIZlRMZ0Z4T09YbC16MXhiV3d3dzNKcFFLbzd0N3dYdkpweHZBejFZVHhnbHctQWVXdnVTc2x4UUNUWnM';

const BATCH_SIZE = 225;

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

export interface RequestWrapper {
	promise: Promise<void>;
	resolve: (_: void) => void;
	reject: (err: any) => void;
	failures: number;
	pixel: PixelRequest;
}

export interface PixelRequest {
	x: number;
	y: number;
	canvasIndex: number;
}

(async () => {
	const requestQueue: RequestWrapper[] = [];

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

	/* async function queueNextBatch2(): Promise<void> {
		const delay = await nextBatch2();

		if (delay === 'empty') {
			return void setTimeout(() => queueNextBatch2(), 100);
		}

		return queueNextBatch2();
	} */

	// Make requests for x batches per second
	setInterval(() => {
		nextBatch2();
	}, 1000 / 8);

	/**
	 * Retrieve the next batch.
	 */
	async function nextBatch2() {
		const batch: RequestWrapper[] = requestQueue.splice(0, BATCH_SIZE);

		if (batch.length === 0) return 'empty';

		const pixels: PixelRequest[] = batch.flatMap((request) => request.pixel);
		console.log(`fetching batch of ${pixels.length}`);

		try {
			const response = await queryPixelHistory(pixels);

			pipe.giveExact({
				source: 'place2.details',
				author: getGlobalAuthor(),
				timestamp: Date.now(),
				content: response,
			});

			batch.forEach((request) => request.resolve());
		} catch (ex) {
			// Requeue
			batch.forEach((request) => {
				request.failures++;

				if (request.failures >= 3) {
					console.log(`batch failure ${request.failures}`);
					request.reject(ex);
				} else {
					requestQueue.push(request);
				}
			});
		}
	}

	async function addRequestToBatch(pixels: PixelRequest): Promise<void> {
		let batchResolve: (_: void) => void;
		let batchReject: (err: any) => void;
		const promise = new Promise<void>((resolve, reject) => {
			batchResolve = resolve;
			batchReject = reject;
		});

		requestQueue.push({
			promise,
			resolve: batchResolve!,
			reject: batchReject!,
			failures: 0,
			pixel: pixels,
		});

		return promise;
	}

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

			await channel.assertQueue('place2.pixelRequests', {
				durable: true,
			});

			await channel.bindQueue('place2.pixelRequests', 'place2', 'pixelRequest.*');

			// Limit to processing a limited number of pixels at a time, and preload a bunch of pixels so the queue is always fed
			await channel.prefetch(BATCH_SIZE * 32);

			return 'place2.pixelRequests';
		},
		async transform(data): Promise<NewData | null> {
			const pixelRequest: PixelRequest = JSON.parse(data.content.toString('utf8'));

			await addRequestToBatch(pixelRequest);

			return null;
		},
	});

	// ---

	await amqpIn.enable();

	// queueNextBatch2();
})();
