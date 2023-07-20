# Components

- `websocket-listener.ts` - Pulls data from the websocket, then pushes it to a file and rabbit. Maintains two concurrent connections for safety.
- `canvas-downloader.ts` - Takes websocket data from rabbit, downloads the canvas at the url contained within the message, then pushes it to a file and rabbit.
- `details.ts` - Takes canvas diff images from rabbit, extracts changed pixel positions from them, then requests the pixel history for all of them from reddit API. Should've been split into two components. An early version of this file used a WebSocket instead of HTTP requests, but I made some mistake in the request format, resulting in Reddit rejecting my requests with a 1006 close code.
- `details-unbatched.ts` - Backup copy of an earlier version of `details.ts` which doesn't attempt to batch the requests. Ended up being used while I was falling behind on real-time processing of the data and rewriting the code to split pixel extraction into a separate file.
- `pixel-extractor.ts` - Extracts changed pixels from diff images, then pushes them to a file and rabbit.
- `details-requests.ts` - Takes batches of pixel requests from rabbit, then sends requests to Reddit API to retrieve information about those pixels. This gave me much better control over request rate and batch size, allowing me to stay closer to real-time throughout the rest of the event. The batch size was brought down from 400 to 200, then later up to 225 while falling behind. It was a balancing act between API response times and not hitting the rate limit.


# Mistakes

- Late `pixels` files contain no canvas index for pixels soon after the transition. This was fixed in `pixels2`, which also has a different format.
- `canvaspng` from soon after addition of canvas 1 contain full frames for canvas 1 which are labelled as canvas 0. Good luck!
- `canvaspng` from a little later label canvases based on their subscription id: `2` for canvas 0 diffs, `3` for canvas 0 full, `4` for canvas 1 diffs, and `5` for canvas 1 full.
- `pixelws` were tests to see if it's possible to subscribe to pixel changes directly. It's not.
- `vscode-server` decided to just stop working and kill all terminals while i was asleep on day three. fucking lovely, thanks.


# Dependencies

- RabbitMQ for communication between the components. Example command to start it with Docker is in `docker/start-rabbit.sh`.
- `ingester` for piping data around. Can be found at <https://github.com/opl-/live-data-processing>.
