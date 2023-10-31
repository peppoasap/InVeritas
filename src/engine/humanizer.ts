/**
 * =============== HUMANIZER ===============
 * Humanizer is the main istance of the human processes.
 * It is responsible for the creation of human workers processes and the communication with them.
 */
import { Worker } from 'worker_threads';
import { Result } from '@vladmandic/human';
import { getBaseFfmpegCommand } from './transcoder';
import { Socket } from 'socket.io';

const Pipe2Jpeg = require('pipe2jpeg');

class Humanizer {
  private numWorkers: number;
  private workers: { worker: Worker; isBusy: boolean }[] = [];
  private pipe2jpeg = new Pipe2Jpeg();

  constructor(numWorkers: number = 1) {
    this.numWorkers = numWorkers;

    for (let i = 0; i < this.numWorkers; i++) {
      const worker = new Worker('./src/engine/humanizerWorker.js', {
        name: `humanizer#${i}`,
      });
      this.workers.push({ worker, isBusy: false });
    }
  }

  run(guid: string, socket: Socket) {
    this.pipe2jpeg.on('data', async (jpegBuffer: any) => {
      console.log(`#${guid}# Buffer::: ${jpegBuffer.length}}`);
      const result = await this.detect(jpegBuffer);
      if (result)
        socket.emit(
          'detectionResult',
          JSON.stringify({
            jpegBuffer: jpegBuffer.toString('base64'),
            result: { ...result },
          }),
        );
    });

    const transcoder = getBaseFfmpegCommand(`${guid}`);
    if (transcoder) {
      transcoder.on('error', (err) => {
        console.log('err', err);
        socket.emit('detectionResult', JSON.stringify({ error: err }));
      });
      transcoder.on('end', () => {
        console.log('Transconding End.');
        socket.emit('detectionResult', JSON.stringify({ end: true }));
      });
      transcoder.on('exit', () => {
        console.log('Transconding Exit.');
        socket.emit('detectionResult', JSON.stringify({ exit: true }));
      });
      transcoder.pipe(this.pipe2jpeg, { end: true });
    } else {
      console.log(`#${guid}# Unable to create transcoder.`);
      socket.emit(
        'detectionResult',
        JSON.stringify({ error: 'Unable to create transcoder.' }),
      );
    }
  }

  detect(jpegBuffer: Buffer): Promise<Result | null> {
    return new Promise<Result | null>((resolve, reject) => {
      const workerRef = this.getAvailableWorker();
      if (!workerRef) {
        resolve(null);
        return;
      }

      workerRef.worker.postMessage({ action: 'detect', jpegBuffer });

      workerRef.worker.once('message', (result: Result) => {
        this.releaseWorker(workerRef);
        resolve(result);
      });

      workerRef.worker.once('error', (error) => {
        this.releaseWorker(workerRef);
        reject(error);
      });
    });
  }

  private getAvailableWorker(): { worker: Worker; isBusy: boolean } | null {
    for (const workerRef of this.workers) {
      if (workerRef.isBusy === false) {
        workerRef.isBusy = true;
        return workerRef;
      }
    }
    return null;
  }

  private releaseWorker(workerRef: { worker: Worker; isBusy: boolean }) {
    workerRef.isBusy = false;
  }

  close() {
    for (const workerRef of this.workers) {
      workerRef.worker.terminate();
    }
  }
}

// worker thread
// if (!isMainThread) {
//   const { workerIndex } = workerData;
//   let human = new Human(humanConfig);

//   const init = async () => {
//     human.tf.ready();
//     console.info('human:', human.version, 'tf:', tf.version_core);
//     console.info('Human:', human.version);
//     await human.load();
//   };

//   init().then(() => {
//     parentPort?.on('message', async (message) => {
//       if (message.action === 'detect') {
//         const tensor = human?.tf.node.decodeJpeg(message.jpegBuffer, 3); // decode jpeg buffer to raw tensor
//         const result = await human.detect(tensor);
//         human?.tf.dispose(tensor); // release tensor memory
//         parentPort?.postMessage(result);
//       }
//     });
//   });
// }

export default Humanizer;
