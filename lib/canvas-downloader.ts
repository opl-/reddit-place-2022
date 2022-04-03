process.env.INGESTER_AUTHOR = 'opl';

import {Buffer} from 'buffer';
import {AmqpSink, AmqpTap, FileSink, NewData, Pipe, setGlobalAuthor} from 'ingester';
import fetch from 'node-fetch';

// import {amqpAuth} from './auth';

// FIXME: author name gets set to hostname in websocket tap
setGlobalAuthor('opl');

export type FrameData = FullFrameData | DiffFrameData;

export interface FullFrameData {
	payload: {
		data: {
			subscribe: {
				/**
				 * UUID
				 */
				id: string;
				data: {
					__typename: 'FullFrameMessageData';
					/**
					 * "https://hot-potato.reddit.com/media/canvas-images/1648828567932-0-f-2RDYZ0si.png"
					 */
					name: string;
					timestamp: number;
				}
			}
		}
	}
	id: string;
	type: "data";
}

export interface DiffFrameData {
	payload: {
		data: {
			subscribe: {
				/**
				 * UUID
				 */
				id: string;
				data: {
					__typename: 'DiffFrameMessageData',
					/**
					 * "https://hot-potato.reddit.com/media/canvas-images/1648826442749-0-d-HQO2qvhY.png"
					 */
					name: string;
					currentTimestamp: number;
					previousTimestamp: number;
				}
			}
		}
	};
	id: string;
	type: 'data';
}

(async () => {
	let lastFullFrameTimestamp: Record<string, number> = {};
	const recentUrls: string[] = [];

	const amqpIn = new AmqpTap({
		name: 'canvasDownloader',
		hostname: 'localhost',
		vhost: '/',
		username: 'place2',
		password: 'OQvT2GLnludwuFmKyrARMLy9',
		async createQueue(channel): Promise<string> {
			await channel.assertExchange('place2', 'topic', {
				durable: true,
				autoDelete: false,
			});

			await channel.assertQueue('place2.ws', {
				durable: true,
			});

			await channel.bindQueue('place2.ws', 'place2', 'ws.#');

			// Limit to processing a few messages at a time
			await channel.prefetch(6);

			return 'place2.ws';
		},
		async transform(data): Promise<NewData | null> {
			let json: FrameData;
			try {
				json = JSON.parse(data.content.toString('utf8'));
			} catch (ex) {
				return null;
			}

			const typeName = json?.payload?.data?.subscribe?.data?.__typename;

			if (typeName !== 'FullFrameMessageData' && typeName !== 'DiffFrameMessageData') {
				return null;
			}

			let subscriptionId = json.id;

			// Backwards compat
			if (subscriptionId === '2') subscriptionId = 'd0';
			else if (subscriptionId === '3') subscriptionId = 'f0';
			else if (subscriptionId === '4') subscriptionId = 'd1';
			else if (subscriptionId === '5') subscriptionId = 'f1';

			const match = /^([df])(\d+)$/.exec(subscriptionId);
			if (match === null) throw new Error(`Unknown subscription id: ${subscriptionId}`);

			const fullFrameSubscription = match[1] === 'f';
			const canvasId = parseInt(match[2]);

			// Download full frames only every 10 seconds.
			// Full frames from DiffFrameMessageData subcriptions should always be downloaded (first frame of the stream - need it to know initial state).
			if (fullFrameSubscription) {
				if (typeName === 'FullFrameMessageData' && (lastFullFrameTimestamp[canvasId] ?? 0) + 10000 < json.payload.data.subscribe.data.timestamp) {
					lastFullFrameTimestamp[canvasId] = json.payload.data.subscribe.data.timestamp;
					// pass
				} else {
					return null;
				}
			}

			const url = json.payload.data.subscribe.data.name;

			// Don't download twice
			if (recentUrls.includes(url)) {
				return null;
			}

			recentUrls.push(url);
			if (recentUrls.length > 100) {
				recentUrls.shift();
			}

			let imageData: Buffer;
			try {
				imageData = Buffer.from(await (await fetch(url)).arrayBuffer());
			} catch (ex) {
				// Ensure we don't skip the url in case of failure
				const index = recentUrls.indexOf(url);
				if (index !== -1) recentUrls.splice(index, 1);

				throw ex;
			}

			if (typeName === 'FullFrameMessageData') {
				return {
					source: `${amqpIn.sourceName}.${canvasId}.full`,
					timestamp: json.payload.data.subscribe.data.timestamp,
					content: imageData,
				};
			} else {
				return {
					source: `${amqpIn.sourceName}.${canvasId}`,
					timestamp: json.payload.data.subscribe.data.currentTimestamp,
					content: imageData,
				};
			}
		},
	});

	const pipe = new Pipe();

	const fileSink = new FileSink({
		path: '/home/opl/place2/data/canvaspng-$t.csv',
		mode: 'binary',
	});
	const amqpSink = new AmqpSink({
		hostname: 'localhost',
		vhost: '/',
		username: 'place2',
		password: 'OQvT2GLnludwuFmKyrARMLy9',
		exchange: 'place2',
		routingKeyPrefix: 'canvasPng.',
	});

	await fileSink.enable();
	await amqpSink.enable();

	amqpIn.connectSink(pipe);

	pipe.connectSink(fileSink);
	pipe.connectSink(amqpSink);

	await amqpIn.enable();
})();
