import Jimp from 'jimp';
import {Worker, isMainThread, parentPort, workerData} from 'worker_threads';
import {PixelRequest} from './details';

if (isMainThread || !parentPort) {
	console.error('Tried to start worker as main thread');
	process.exit(1);
}

parentPort.on('message', async (buffer: Buffer) => {
	const image = await Jimp.read(buffer);
	const pixels: PixelRequest[] = [];

	for (let y = 0; y < image.getHeight(); y++) {
		for (let x = 0; x < image.getWidth(); x++) {
			const rawColor = image.getPixelColor(x, y);
			const color = Jimp.intToRGBA(rawColor);

			if (color.a > 0) {
				pixels.push({
					x,
					y,
					canvasIndex: 0,
				});
			}
		}
	}

	parentPort?.postMessage(pixels);
});
