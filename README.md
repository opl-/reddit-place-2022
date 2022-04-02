# Components

- `websocket-listener.ts` - Pulls data from the websocket, then pushes it to a file and rabbit. Maintains two concurrent connections for safety.
- `canvas-downloader.ts` - Takes websocket data from rabbit, downloads the canvas at the url contained within the message, then pushes it to a file and rabbit.
- `details.ts` - Takes canvas diff images from rabbit, extracts changed pixel positions from them, then requests the pixel history for all of them from reddit API. Should've been split into two components.
- `extractPixels.ts` - Unfinished worker to extract changed pixels from diff images.
