# Components

- `websocket-listener.ts` - Pulls data from the websocket, then pushes it to a file and rabbit. Maintains two concurrent connections for safety.
- `canvas-downloader.ts` - Takes websocket data from rabbit, downloads the canvas at the url contained within the message, then pushes it to a file and rabbit.
- `details.ts` - Takes canvas diff images from rabbit, extracts changed pixel positions from them, then requests the pixel history for all of them from reddit API. Should've been split into two components.
- `pixel-extractor.ts` - Extracts changed pixels from diff images, then pushes them to a file and rabbit.


# Mistakes

- Late `pixels` files contain no canvas index for pixels soon after the transition. This was fixed in `pixels2`, which also has a different format.
- `canvaspng` from soon after addition of canvas 1 contain full frames for canvas 1 which are labelled as canvas 0. Good luck!
- `pixelws` were tests to see if it's possible to subscribe to pixel changes directly. It's not.
