process.env.INGESTER_AUTHOR = 'opl';

import {AmqpSink, AmqpTap, FileSink, getGlobalAuthor, NewData, Pipe, setGlobalAuthor} from 'ingester';
import Jimp from 'jimp';
import {PixelRequest} from './details';

// FIXME: author name gets set to hostname in websocket tap
setGlobalAuthor('opl');

export interface PixelChange extends PixelRequest {
	color: number;
}

(async () => {
	const pixelRequestsAmqpSink = new AmqpSink({
		hostname: 'localhost',
		vhost: '/',
		username: 'place2',
		password: 'OQvT2GLnludwuFmKyrARMLy9',
		exchange: 'place2',
		routingKeyPrefix: 'pixelRequest.',
	});

	const amqpIn = new AmqpTap({
		name: 'pixelExtractor',
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

			await channel.bindQueue('place2.canvasPngDetails', 'place2', 'canvasPng.*.*');

			// Limit to processing a few messages at a time
			await channel.prefetch(2);

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

			const pixels: PixelChange[] = [];

			for (let y = 0; y < image.bitmap.height; y++) {
				for (let x = 0; x < image.bitmap.width; x++) {
					const pixelIndex = (image.bitmap.width * y + x) << 2;
					const color = image.bitmap.data.readUInt32BE(pixelIndex);

					if (color > 0) {
						// Request history information from Reddit
						pixelRequestsAmqpSink.take({
							author: getGlobalAuthor(),
							timestamp: data.timestamp,
							source: `${amqpIn.sourceName}`,
							content: Buffer.from(JSON.stringify(<PixelRequest> {
								x,
								y,
								canvasIndex,
							})),
						});

						const pixel: PixelChange = {
							x,
							y,
							canvasIndex,
							color,
						};

						pixels.push(pixel);

						// But also announce the pixel change
						amqpIn.give({
							timestamp: data.timestamp,
							content: Buffer.from(JSON.stringify(pixel)),
						});
					}
				}
			}

			pixelsFileSink.take({
				author: getGlobalAuthor(),
				source: 'pixelExtractor',
				timestamp: data.timestamp,
				content: Buffer.from(JSON.stringify({
					changedPixels: pixels.length,
					canvasIndex,
					pixels,
				})),
			});

			return null;
		},
	});

	// ---

	await pixelRequestsAmqpSink.enable();

	// ---

	const pixelsAmqpSink = new AmqpSink({
		hostname: 'localhost',
		vhost: '/',
		username: 'place2',
		password: 'OQvT2GLnludwuFmKyrARMLy9',
		exchange: 'place2',
		routingKeyPrefix: 'pixels.',
	});
	await pixelsAmqpSink.enable();

	const pixelsAmqpPipe = new Pipe();
	pixelsAmqpPipe.connectSink(pixelsAmqpSink);

	amqpIn.connectSink(pixelsAmqpPipe);

	// ---

	const pixelsFileSink = new FileSink({
		path: '/home/opl/place2/data/pixels2-$t.csv',
		mode: 'string',
	});
	await pixelsFileSink.enable();


	// ---

	await amqpIn.enable();
})();
