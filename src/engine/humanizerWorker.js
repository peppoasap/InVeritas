

const tf = require('@tensorflow/tfjs-node');
const Human = require('@vladmandic/human').default;
const { parentPort } = require('worker_threads');
  
    const humanConfig = {
        backend: 'tensorflow',
        modelBasePath: 'file://src/models',
        debug: false,
        async: true,
        cacheSensitivity: 0.6,
        filter: {
          enabled: true,
          width: 128,
          height: 0,
          flip: true,
          return: false,
          brightness: 0,
          contrast: -0.2,
          sharpness: 0.3,
          blur: 0,
          saturation: 0,
          hue: 0,
          negative: false,
          sepia: true,
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
          gear: { enabled: false, skipFrames: 15},
        },
        hand: {
          enabled: false,
        },
        body: { enabled: false },
        object: { enabled: false },
      };

      let human = new Human(humanConfig);
    const init = async () => {
      human.tf.ready();
      console.info('human:', human.version, 'tf:', tf.version_core);
      console.info('Human:', human.version);
      await human.load();
    };
  
    init().then(() => {
        parentPort.on('message', async (message) => {
            if (message.action === 'detect') {
              const tensor = human.tf.node.decodeJpeg(message.jpegBuffer, 3); // decode jpeg buffer to raw tensor
              const result = await human.detect(tensor);
                human.tf.dispose(tensor); // release tensor memory
                parentPort.postMessage(result);
            }
          });
    });

   