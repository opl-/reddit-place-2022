process.env.INGESTER_AUTHOR = 'opl';

import {Buffer} from 'buffer';
import https from 'https';
import {AmqpSink, AmqpTap, FileSink, NewData, Pipe, setGlobalAuthor, WebSocketTap} from 'ingester';
import Jimp from 'jimp';
import {WebSocket} from 'ws';

const COOKIES = 'token_v2=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2NDg4MjM0MTQsInN1YiI6IjM2OTY3ODQ5LUtPVS1MMU9nY3ZQQU1iakZwdkVDYlNiclI1NUY1ZyIsImxvZ2dlZEluIjp0cnVlLCJzY29wZXMiOlsiKiIsImVtYWlsIiwicGlpIl19.B7lEO7V6Vay8YCPIV1vgyYjlBeYuybKPFneCU7n4V6A; csv=2; edgebucket=ha5No9Bt6seRuZXaRQ; loid=0000000000000m0ckp.2.1425914398495.Z0FBQUFBQmlST0l0NkprOUJXVk5fQ0tTM0Rxd3VMRlUwVThhenZicmtfdFJJak1LeGt4M2FLVTQ2bUYxNGkySUx5WEpOTmxKcGJGRDVFUEpVSzlRWE5icmk5MU9QU0cxZzQ3UGFBQmhQRHM2bGh3aDZ0T2JITWZleWtwU0lsaFVOR2NIeGQzaG1CWjA; reddit_session=36967849%2C2022-03-30T23%3A05%3A16%2C0bb4a57fba8f8b06ef9f4dc84d62b8e82af4ad3f; redesign_optout=true; pc=mo; session_tracker=F2u2AgOqDieUvjRRj2.0.1648820382348.Z0FBQUFBQmlSd0NlRUhzTUo3OU5WVnZ3QWQ0YjZHNG5oLVZTcGF4aEpsdUw5X0EtdjNYU05NYmRYNnBXUklXaDVMV05ZemZBakVmaXV6UERIZlRMZ0Z4T09YbC16MXhiV3d3dzNKcFFLbzd0N3dYdkpweHZBejFZVHhnbHctQWVXdnVTc2x4UUNUWnM';

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

// FIXME: author name gets set to hostname in websocket tap
setGlobalAuthor('opl');

/* class WebSocketServerTap extends Tap implements Stateful {
	server: WebSocketServer | null;

	get isEnabled(): boolean {
		return this.server !== null;
	}

	async enable(): Promise<void> {
		this.server = new WebSocketServer({
			port: 10069,
		});

		this.server.on('connection', (conn) => {
			conn.on('message', (data) => {
				const msg = JSON.parse(data.toString('utf8'));

				this.give({

				});
			});
		});
	}

	async disable(): Promise<void> {
		
	}
} */


(async () => {
	let queue: string[] = [];
	let websocket: WebSocket;

	function send(request: string) {
		if (websocket?.readyState !== WebSocket.OPEN) {
			queue.push(request);
			return;
		}

		websocket.send(request);
	}

	// {"operationName":"pixelHistory","variables":{"input":{"actionName":"r/replace:get_tile_history","PixelMessageData":{"coordinate":{"x":797,"y":429},"colorIndex":0,"canvasIndex":0}}},"query":"mutation pixelHistory($input: ActInput!) {\n  act(input: $input) {\n    data {\n      ... on BasicMessage {\n        id\n        data {\n          ... on GetTileHistoryResponseMessageData {\n            lastModifiedTimestamp\n            userInfo {\n              userID\n              username\n              __typename\n            }\n            __typename\n          }\n          __typename\n        }\n        __typename\n      }\n      __typename\n    }\n    __typename\n  }\n}\n"}
	function requestPixelHistory(x: number, y: number, canvasIndex: number = 0) {
		return send('{"operationName":"pixelHistory","variables":{"input":{"actionName":"r/replace:get_tile_history","PixelMessageData":{"coordinate":{"x":' + x + ',"y":' + y + '},"colorIndex":0,"canvasIndex":' + canvasIndex + '}}},"query":"mutation pixelHistory($input: ActInput!) {\\n  act(input: $input) {\\n    data {\\n      ... on BasicMessage {\\n        id\\n        data {\\n          ... on GetTileHistoryResponseMessageData {\\n            lastModifiedTimestamp\\n            userInfo {\\n              userID\\n              username\\n              __typename\\n            }\\n            __typename\\n          }\\n          __typename\\n        }\\n        __typename\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}');
	}

	function createWS(name: string): WebSocketTap {
		let token: string;

		return new WebSocketTap({
			name,
			silenceKill: 10000,
			url: 'wss://gql-realtime-2.reddit.com/query',
			async webSocketOptions() {
				token = await getToken();

				return {
					headers: {
						Origin: 'https://hot-potato.reddit.com',
						Cookie: COOKIES,
						'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:88.0) Gecko/20100101 Firefox/88.0',
					},
				};
			},
			onOpen(ws) {
				websocket = ws as WebSocket;

				ws.send('{"type":"connection_init","payload":{"Authorization":"Bearer ' + token + '"}}');

				// ws.send('{"id":"1","type":"start","payload":{"variables":{"input":{"channel":{"teamOwner":"AFD2022","category":"CONFIG"}}},"extensions":{},"operationName":"configuration","query":"subscription configuration($input: SubscribeInput!) {\\n  subscribe(input: $input) {\\n    id\\n    ... on BasicMessage {\\n      data {\\n        __typename\\n        ... on ConfigurationMessageData {\\n          colorPalette {\\n            colors {\\n              hex\\n              index\\n              __typename\\n            }\\n            __typename\\n          }\\n          canvasConfigurations {\\n            index\\n            dx\\n            dy\\n            __typename\\n          }\\n          canvasWidth\\n          canvasHeight\\n          __typename\\n        }\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}}');
				// ws.send('{"id":"2","type":"start","payload":{"variables":{"input":{"channel":{"teamOwner":"AFD2022","category":"CANVAS_FULL_FRAMES","tag":"0"}}},"extensions":{},"operationName":"replace","query":"subscription replace($input: SubscribeInput!) {\\n  subscribe(input: $input) {\\n    id\\n    ... on BasicMessage {\\n      data {\\n        __typename\\n        ... on FullFrameMessageData {\\n          __typename\\n          name\\n          timestamp\\n        }\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}"}}');
		
				// ws.send('{"id":"1","type":"start","payload":{"variables":{"input":{"channel":{"teamOwner":"AFD2022","category":"CONFIG"}}},"extensions":{},"operationName":"configuration","query":"subscription configuration($input: SubscribeInput!) {\\n  subscribe(input: $input) {\\n    id\\n    ... on BasicMessage {\\n      data {\\n        __typename\\n        ... on ConfigurationMessageData {\\n          colorPalette {\\n            colors {\\n              hex\\n              index\\n              __typename\\n            }\\n            __typename\\n          }\\n          canvasConfigurations {\\n            index\\n            dx\\n            dy\\n            __typename\\n          }\\n          canvasWidth\\n          canvasHeight\\n          __typename\\n        }\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}}');
				// ws.send('{"id":"2","type":"start","payload":{"variables":{"input":{"channel":{"teamOwner":"AFD2022","category":"CANVAS","tag":"1"}}},"extensions":{},"operationName":"replace","query":"subscription replace($input: SubscribeInput!) {\\n  subscribe(input: $input) {\\n    id\\n    ... on BasicMessage {\\n      data {\\n        __typename\\n        ... on FullFrameMessageData {\\n          __typename\\n          name\\n          timestamp\\n        }\\n        ... on DiffFrameMessageData {\\n          __typename\\n          name\\n          currentTimestamp\\n          previousTimestamp\\n        }\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}}');
				// ws.send('{"id":"3","type":"start","payload":{"variables":{"input":{"channel":{"teamOwner":"AFD2022","category":"CANVAS_FULL_FRAMES","tag":"1"}}},"extensions":{},"operationName":"replace","query":"subscription replace($input: SubscribeInput!) {\\n  subscribe(input: $input) {\\n    id\\n    ... on BasicMessage {\\n      data {\\n        __typename\\n        ... on PixelMessageData {\\n          __typename\\n          canvasIndex\\n          colorIndex\\n          coordinate {\\n            x\\n            y\\n          }\\n        }\\n      }\\n      __typename\\n    }\\n    __typename\\n  }\\n}\\n"}}');

				queue.forEach((msg) => {
					ws.send(msg);
				});
				queue.splice(0);
			},
		});
	}

	const ws = createWS('place2.detailsWs');

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

	ws.connectSink(pipe);

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
			await channel.prefetch(1);

			return 'place2.canvasPngDetails';
		},
		async transform(data): Promise<NewData | null> {
			const image = await Jimp.read(data.content);

			for (let y = 0; y < image.getHeight(); y++) {
				for (let x = 0; x < image.getWidth(); x++) {
					const rawColor = image.getPixelColor(x, y);
					const color = Jimp.intToRGBA(rawColor);

					if (color.a > 0) {
						// Request history information from Reddit
						requestPixelHistory(x, y);

						// But also announce the pixel change
						amqpIn.give({
							timestamp: data.timestamp,
							content: Buffer.from(JSON.stringify({
								x,
								y,
								color: rawColor,
							})),
						});
					}
				}
			}

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

	await ws.enable();
	await amqpIn.enable();
})();
