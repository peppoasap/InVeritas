import * as tf from '@tensorflow/tfjs-node';
import { Config, Human } from '@vladmandic/human';
import { getBaseFfmpegCommand } from './transcoder';
import { Socket } from 'socket.io';
const Pipe2Jpeg = require('pipe2jpeg');

let human: Human | null = null;
let pipe2jpeg = new Pipe2Jpeg();
let busy = false; // busy flag

const config: Partial<Config> = {
  backend: 'tensorflow',
  modelBasePath: 'file://src/models',
  debug: false,
  async: true,
  cacheSensitivity: 0.5,
  filter: {
    enabled: true,
    width: 0,
    height: 0,
    flip: true,
    return: false,
    brightness: 0,
    contrast: 0,
    sharpness: 0,
    blur: 0,
    saturation: 0,
    hue: 0,
    negative: false,
    sepia: false,
    vintage: false,
    kodachrome: false,
    technicolor: false,
    polaroid: false,
    pixelate: 0,
  },
  gesture: {
    enabled: false,
  },
  face: {
    enabled: true,
    detector: {
      rotation: true,
      maxDetected: 1,
      skipFrames: 8,
      minConfidence: 0.3,
      iouThreshold: 0.1,
      return: false,
      enabled: true,
    },
    mesh: { enabled: false },
    iris: { enabled: true, skipFrames: 9 },
    description: { enabled: true, skipFrames: 10, minConfidence: 0.1 },
    emotion: { enabled: true, minConfidence: 0.2, skipFrames: 17 },
    antispoof: { enabled: true, skipFrames: 11 },
    liveness: { enabled: true, skipFrames: 11 },
    attention: { enabled: true, skipFrames: 11 },
    gear: { enabled: true, skipFrames: 15 },
  },
  hand: {
    enabled: false,
  },
  body: { enabled: false },
  object: { enabled: false },
};

async function init() {
  // create instance of human
  if (human) return;
  human = new Human(config);
  // wait until tf is ready
  await human.tf.ready();
  console.info('human:', human.version, 'tf:', tf.version_core);
  // pre-load models
  console.info('Human:', human.version);
  // log.info('Active Configuration', human.config);
  await human.load();
  console.info('Loaded:', human.models.loaded());
}

// async function toTensor(img: string) {
//   if (human) {
//     const tensor = human.tf.tidy(() => {
//       const decode = human!.tf.node.decodeImage(Buffer.from(img, 'base64'), 3);
//       let expand;
//       if (decode.shape[2] === 4) {
//         // input is in rgba format, need to convert to rgb
//         const channels = human!.tf.split(decode, 4, 2); // tf.split(tensor, 4, 2); // split rgba to channels
//         const rgb = human!.tf.stack([channels[0], channels[1], channels[2]], 2); // stack channels back to rgb and ignore alpha
//         expand = human!.tf.reshape(rgb, [
//           1,
//           decode.shape[0],
//           decode.shape[1],
//           3,
//         ]); // move extra dim from the end of tensor and use it as batch number instead
//       } else {
//         expand = human!.tf.expandDims(decode, 0);
//       }
//       const cast = human!.tf.cast(expand, 'float32');
//       return cast;
//     });
//     return tensor;
//   }
// }

async function execute(jpegBuffer: any) {
  // if (busy) return; // skip processing if busy
  busy = true;
  const tensor = human?.tf.node.decodeJpeg(jpegBuffer, 3); // decode jpeg buffer to raw tensor
  const result = await human?.detect(tensor);
  human?.tf.dispose(tensor); // release tensor memory
  busy = false;
  return result;
}

export async function detect(guid: string, socket: Socket) {
  await init();
  pipe2jpeg.on('data', async (jpegBuffer: any) => {
    console.log('jpegBuffer', jpegBuffer);
    const result = await execute(jpegBuffer);
    socket.emit(
      'detectionResult',
      JSON.stringify({
        result: { ...result },
      }),
    );
  });

  const transcoder = getBaseFfmpegCommand(`tmp/sdp/${guid}.sdp`);
  transcoder.on('error', (err) => {
    console.log('err', err);
    socket.emit('detectionResult', JSON.stringify({ error: err }));
  });
  transcoder.on('end', () => {
    console.log('Transconding End.');
    socket.emit('detectionResult', JSON.stringify({ end: true }));
  });
  // transcoder.on('stderr', (line) => {
  //   console.log('[[[STD]]]', line);
  // });
  transcoder.pipe(pipe2jpeg);
}
