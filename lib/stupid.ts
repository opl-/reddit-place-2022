import {PixelRequest} from './details';
import {getToken} from './util';

async function requestPixelHistory(pixels: PixelRequest[]): Promise<void> {
	if (pixels.length === 0) {
		return;
	}

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
			Authorization: `Bearer ${await getToken()}`,
			'Content-Type': 'application/json',
			'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:88.0) Gecko/20100101 Firefox/88.0',
		},
	});

	if (!response.ok) {
		console.log(response);
		throw new Error('fetch response not ok');
	}

	require('fs').writeFileSync('./canvas.json', await response.arrayBuffer());
}

const pixels: PixelRequest[] = [];

for (let y = 0; y < 1000; y++) {
	for (let x = 0; x < 1000; x++) {
		pixels.push({
			x,
			y,
			canvasIndex: 0,
		});
	}
}

requestPixelHistory(pixels);
