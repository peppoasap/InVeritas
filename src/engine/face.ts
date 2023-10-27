import * as tf from '@tensorflow/tfjs-node';
import { Config, Human } from '@vladmandic/human';

export async function toTensor(human: Human, img: string) {
  if (human) {
    const tensor = human.tf.tidy(() => {
      if (img.startsWith('data:image/')) {
        img = img.replace(/^data:image\/(png|jpg|jpeg);base64,/, '');
      }
      const decode = human!.tf.node.decodeImage(Buffer.from(img, 'base64'), 3);
      let expand;
      if (decode.shape[2] === 4) {
        // input is in rgba format, need to convert to rgb
        const channels = human!.tf.split(decode, 4, 2); // tf.split(tensor, 4, 2); // split rgba to channels
        const rgb = human!.tf.stack([channels[0], channels[1], channels[2]], 2); // stack channels back to rgb and ignore alpha
        expand = human!.tf.reshape(rgb, [
          1,
          decode.shape[0],
          decode.shape[1],
          3,
        ]); // move extra dim from the end of tensor and use it as batch number instead
      } else {
        expand = human!.tf.expandDims(decode, 0);
      }
      const cast = human!.tf.cast(expand, 'float32');
      return cast;
    });
    return tensor;
  }
}

export class FaceDetection {
  human: Human | null = null;

  config: Partial<Config> = {
    backend: 'tensorflow',
    modelBasePath: 'file://src/models',
    async: true,
    filter: {
      enabled: false,
      flip: true,
    },
    face: {
      enabled: true,
      detector: {
        enabled: true,
        rotation: true,
        maxDetected: 5,
        minConfidence: 0.7,
      },
      mesh: { enabled: true },
      iris: { enabled: false },
      description: { enabled: true },
      antispoof: { enabled: true },
      liveness: { enabled: true },
      gear: { enabled: true, modelPath: 'file://src/models/gear.json' },
      skipTime: 350,
    },
    hand: {
      enabled: false,
    },
    body: { enabled: false },
    object: { enabled: false },
    cacheModels: true,
    cacheSensitivity: 0.5,
  };

  constructor() {
    this.init();
  }

  async init() {
    // create instance of human
    if (this.human) return;
    this.human = new Human(this.config);
    // wait until tf is ready
    await this.human.tf.ready();
    console.info('human:', this.human.version, 'tf:', tf.version_core);
    // pre-load models
    console.info('Human:', this.human.version);
    // log.info('Active Configuration', human.config);
    await this.human.load();
    console.info('Loaded:', this.human.models.loaded());
  }

  public async detect(img: string) {
    if (!this.human) return;
    const tensor = await toTensor(this.human, img);
    if (!tensor) return;
    const result = await this.human!.detect(tensor);
    return result;
  }

  public async countPersons(img: string) {
    const result = await this.detect(img);
    if (!result) return 0;
    return result.persons.length;
  }

  public async getPersons(img: string) {
    const result = await this.detect(img);
    if (!result) return;
    return result.persons;
  }

  public async getEmotions(img: string) {
    const result = await this.detect(img);
    if (!result) return;
    return result.face.map((face) =>
      face.emotion?.reduce((prev, current) =>
        prev.score > current.score ? prev : current,
      ),
    );
  }

  public async getPersonsAnalysis(img: string) {
    const result = await this.detect(img);
    if (!result) return;
    return result.persons.map((person) => ({
      name: person.id,
      emotion: person.face.emotion?.reduce((prev, current) =>
        prev.score > current.score ? prev : current,
      ),
      age: person.face.age,
      gender: { score: person.face.genderScore, label: person.face.gender },
      race: person.face.race?.reduce((prev, current) =>
        prev.score > current.score ? prev : current,
      ),
      real: {
        score: person.face.real,
        label: (person.face.real || 0) > 0.6 ? 'real' : 'fake',
      },
      live: {
        score: person.face.live,
        label: (person.face.live || 0) > 0.6 ? 'live' : 'fake',
      },
    }));
  }
}
