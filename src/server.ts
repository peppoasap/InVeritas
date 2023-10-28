/* eslint-disable @typescript-eslint/indent */
import express, { Application } from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';

import * as middlewares from './middlewares';
import api from './api';
import MessageResponse from './interfaces/MessageResponse';
import { Socket, Server as SocketIOServer } from 'socket.io';
import { createServer, Server as HTTPServer } from 'https';
import path from 'path';
import { FaceDetection } from './engine/face';
import * as mediasoup from 'mediasoup';
import {
  Worker,
  Consumer,
  Producer,
  Router,
  Transport,
  RtpCapabilities,
  PlainTransport,
} from 'mediasoup/node/lib/types';
import { config } from './config';
import fs from 'fs';
import { detect } from './engine/detection';
// import { StreamInput } from 'fluent-ffmpeg-multistream';

require('dotenv').config();

export class Server {
  private app: Application = express();

  private httpServer: HTTPServer | undefined;
  private mediasoupServer: HTTPServer | undefined;

  private io: SocketIOServer | undefined;

  private worker: Worker | undefined;

  private producerTransport: Transport | undefined;

  private consumerTransport: Transport | undefined;

  private mediasoupRouter: Router | undefined;

  private producer: Producer | undefined;

  private consumer: Consumer | undefined;

  private activeSockets: string[] = [];

  private faceDetector: FaceDetection = new FaceDetection();

  private config = config;

  //singleton instance
  private static instance: Server;

  public static getInstance(): Server {
    if (!Server.instance) {
      Server.instance = new Server();
    }
    return Server.instance;
  }

  constructor() {
    this.initialize();
    this.handleRoutes();
    this.handleSocket();
  }

  private initialize() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(morgan('dev'));
    this.app.use(helmet());
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(middlewares.notFound);
    this.app.use(middlewares.errorHandler);

    const { sslKey, sslCrt } = config;
    if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
      console.error('SSL files are not found. check your config.js file');
      process.exit(0);
    }

    const tls = {
      cert: fs.readFileSync(sslCrt),
      key: fs.readFileSync(sslKey),
    };

    this.httpServer = createServer(tls, this.app);
    this.httpServer.on('error', (err) => {
      console.error('starting web server failed:', err);
    });

    this.startExpressServer();

    this.io = new SocketIOServer(this.httpServer, {
      serveClient: false,
      path: '/server',
      cors: {
        origin: [
          'http://localhost:4200',
          'https://concilium.space',
          'localhost:*',
          '*',
        ],
        methods: ['GET', 'POST'],
      },
    });
  }

  private handleRoutes() {
    this.app.get<{}, MessageResponse>('/', (req, res) => {
      res.json({
        message: '🦄🌈✨👋🌎🌍🌏✨🌈🦄',
      });
    });
    this.app.use('/api/v1', api);
  }

  private handleSocket() {
    if (!this.io) throw new Error('Socket is not initialized');
    this.io.on('connection', (socket) => {
      socket.on('disconnect', () => {
        console.log('client disconnected');
      });
      socket.on('connect_error', (err) => {
        console.error('client connection error', err);
      });
      socket.on('getRouterRtpCapabilities', (data, callback) => {
        if (!this.mediasoupRouter) return;
        callback(this.mediasoupRouter.rtpCapabilities);
      });
      socket.on('createProducerTransport', async (data, callback) => {
        try {
          const { transport, params } = await this.createWebRtcTransport();
          this.producerTransport = transport;
          callback(params);
        } catch (err: any) {
          console.error(err);
          callback({ error: err.message });
        }
      });
      socket.on('createConsumerTransport', async (data, callback) => {
        try {
          const { transport, params } = await this.createWebRtcTransport();
          this.consumerTransport = transport;
          callback(params);
        } catch (err: any) {
          console.error(err);
          callback({ error: err.message });
        }
      });
      socket.on('connectProducerTransport', async (data, callback) => {
        if (!this.producerTransport) return;

        await this.producerTransport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        callback();
      });
      socket.on('connectConsumerTransport', async (data, callback) => {
        if (!this.consumerTransport) return;

        await this.consumerTransport.connect({
          dtlsParameters: data.dtlsParameters,
        });
        callback();
      });
      socket.on('produce', async (data, callback) => {
        const { kind, rtpParameters } = data;
        if (!this.producerTransport) return;
        this.producer = await this.producerTransport.produce({
          kind,
          rtpParameters,
        });
        callback({ id: this.producer.id });

        // inform clients about new producer
        socket.broadcast.emit('newProducer');
      });
      socket.on('consume', async (data, callback) => {
        if (!this.producer) return;
        callback(
          await this.createConsumer(this.producer, data.rtpCapabilities),
        );
      });
      socket.on('resume', async (data, callback) => {
        if (!this.consumer) return;
        await this.consumer.resume();
        callback();
      });
      socket.on('startRecording', async (data, callback) => {
        const rtpVideoConsumer = await this.createRtpVideoConsumer();
        callback(rtpVideoConsumer.id);
      });

      socket.on('detect', async (data) => {
        await detect(data.guid, socket);
      });
    });
    this.io.on('disconnect', (socket) => {
      console.log('Socket disconnected:', socket.id);
      this.activeSockets = this.activeSockets.filter(
        (existingSocket) => existingSocket !== socket.id,
      );
    });
  }

  private async runMediasoupWorker() {
    this.worker = await mediasoup.createWorker({
      logLevel: this.config.mediasoup.worker.logLevel,
      logTags: this.config.mediasoup.worker.logTags,
      rtcMinPort: this.config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: this.config.mediasoup.worker.rtcMaxPort,
    });

    if (!this.worker) throw new Error('Worker is not initialized');

    this.worker.on('died', () => {
      if (!this.worker) throw new Error('Worker is not initialized');
      console.error(
        'mediasoup worker died, exiting in 2 seconds... [pid:%d]',
        this.worker.pid,
      );
      setTimeout(() => process.exit(1), 2000);
    });

    const mediaCodecs = this.config.mediasoup.router.mediaCodecs;
    this.mediasoupRouter = await this.worker.createRouter({ mediaCodecs });
  }

  private async createWebRtcTransport() {
    const { initialAvailableOutgoingBitrate } =
      this.config.mediasoup.webRtcTransport;

    if (!this.mediasoupRouter) throw new Error('Router is not initialized');
    if (!this.config.mediasoup.webRtcTransport.listenIps)
      throw new Error('Listen ips is not initialized');
    const transport = await this.mediasoupRouter.createWebRtcTransport({
      listenIps: this.config.mediasoup.webRtcTransport.listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate,
    });

    return {
      transport,
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      },
    };
  }

  private async createConsumer(
    producer: Producer,
    rtpCapabilities: RtpCapabilities,
  ) {
    if (
      this.mediasoupRouter &&
      !this.mediasoupRouter.canConsume({
        producerId: producer.id,
        rtpCapabilities,
      })
    ) {
      console.error('can not consume');
      return;
    }
    try {
      if (!this.consumerTransport)
        throw new Error('Consumer transport is not initialized');

      this.consumer = await this.consumerTransport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: false,
      });
    } catch (error) {
      console.error('consume failed', error);
      return;
    }

    if (this.consumer.type === 'simulcast') {
      await this.consumer.setPreferredLayers({
        spatialLayer: 2,
        temporalLayer: 2,
      });
    }

    return {
      producerId: producer.id,
      id: this.consumer.id,
      kind: this.consumer.kind,
      rtpParameters: this.consumer.rtpParameters,
      type: this.consumer.type,
      producerPaused: this.consumer.producerPaused,
    };
  }

  async createRtpVideoConsumer() {
    if (!this.mediasoupRouter) throw new Error('Router is not initialized');
    const rtpTransport = await this.mediasoupRouter.createPlainTransport({
      comedia: false,
      rtcpMux: false,
      ...this.config.mediasoup.plainTransport,
    });

    await rtpTransport.connect({
      ip: this.config.mediasoup.recording.ip,
      port: this.config.mediasoup.recording.port,
      rtcpPort: this.config.mediasoup.recording.rtcpPort,
    });

    console.log(
      'mediasoup VIDEO RTP SEND transport connected: %s:%d <--> %s:%d (%s)',
      rtpTransport.tuple.localIp,
      rtpTransport.tuple.localPort,
      rtpTransport.tuple.remoteIp,
      rtpTransport.tuple.remotePort,
      rtpTransport.tuple.protocol,
    );

    if (rtpTransport.rtcpTuple) {
      console.log(
        'mediasoup VIDEO RTCP SEND transport connected: %s:%d <--> %s:%d (%s)',
        rtpTransport.rtcpTuple.localIp,
        rtpTransport.rtcpTuple.localPort,
        rtpTransport.rtcpTuple.remoteIp,
        rtpTransport.rtcpTuple.remotePort,
        rtpTransport.rtcpTuple.protocol,
      );
    }

    console.log(
      'mediasoup VIDEO RTP SEND transport connected: %s:%d <--> %s:%d (%s)',
      rtpTransport.tuple.localIp,
      rtpTransport.tuple.localPort,
      rtpTransport.tuple.remoteIp,
      rtpTransport.tuple.remotePort,
      rtpTransport.tuple.protocol,
    );

    if (!this.producer) throw new Error('Producer is not initialized');
    const rtpVideoConsumer = await rtpTransport.consume({
      producerId: this.producer.id,
      rtpCapabilities: this.mediasoupRouter.rtpCapabilities,
      paused: true,
    });
    setInterval(() => {
      rtpVideoConsumer.getStats().then((stats) => {
        console.log('[VIDEO CONSUMER] RTP Plain Stats', stats);
      });
    }, 20000);

    console.log(
      'mediasoup VIDEO RTP SEND consumer created, kind: %s, type: %s, paused: %s, SSRC: %s CNAME: %s',
      rtpVideoConsumer.kind,
      rtpVideoConsumer.type,
      rtpVideoConsumer.paused,
      rtpVideoConsumer.rtpParameters.encodings,
      rtpVideoConsumer.rtpParameters.rtcp,
    );

    console.log('rtpVideoConsumer', rtpVideoConsumer.producerId);
    await rtpVideoConsumer.resume();
    // const inputUri = `rtp://${rtpTransport.tuple.remoteIp}:${rtpTransport.tuple.remotePort}`;
    const sdpFileUri = this.createSdpFile(
      rtpTransport,
      rtpVideoConsumer.producerId,
    );
    console.log('[URI] SDP FILE URI', sdpFileUri);
    // console.log('inputUri', inputUri);
    // const stream = fs.createWriteStream(`tmp/${rtpTransport.id}.png`);
    // setTimeout(() => {
    //   const ffmpegCommand = ffmpeg(fs.createReadStream(sdpFile), {
    //     logger: console,
    //   })
    //     .inputOptions(['-protocol_whitelist', 'file,rtp,udp,pipe', '-f', 'sdp'])
    //     // .outputOptions([
    //     //   '-preset',
    //     //   'ultrafast',
    //     //   '-f',
    //     //   'image2',
    //     //   '-pix_fmt',
    //     //   'rgb24',
    //     //   '-vcodec',
    //     //   'png',
    //     //   '-s',
    //     //   VIDEO_OUTPUT_SIZE,
    //     // ])
    //     .on('start', (start) => {
    //       console.log('start', start);
    //     })
    //     .on('codecData', (data) => {
    //       console.log('codecData', data);
    //     })
    //     .on('progress', (progress) => {
    //       console.log('progress', progress);
    //     })
    //     .on('error', (err) => {
    //       console.log('err', err);
    //     })
    //     .on('end', () => {
    //       console.log('Transconding End.');
    //     })
    //     .outputOptions([
    //       '-preset',
    //       'ultrafast',
    //       '-s',
    //       VIDEO_OUTPUT_SIZE,
    //       '-q:v',
    //       '0.5',
    //     ])
    //     .outputFPS(5)
    //     .output(`tmp/${rtpTransport.id}/%03d.jpg`);
    //   ffmpegCommand.run();
    // }, 500);

    // setTimeout(() => {
    //   ffmpegCommand.kill('SIGINT');
    // }, 5000);
    return rtpVideoConsumer;
  }

  createSdpFile = (rtpTransport: PlainTransport, id: string) => {
    const sdpFile = `v=0
    o=- 0 0 IN IP4 ${rtpTransport.tuple.localIp}
    s=WebRTC Video Stream
    t=0 0
    m=video ${rtpTransport.tuple.remotePort} RTP/SAVPF 97
    c=IN IP4 ${rtpTransport.tuple.localIp}
    a=rtcp:${rtpTransport.rtcpTuple?.remotePort}
    a=recvonly
    a=rtpmap:97 VP8/90000
    a=rtcp-fb:97 nack pli
    a=mid:video
    a=rtcp-mux
    a=framerate:30
    `;
    fs.writeFileSync(`tmp/sdp/${id}.sdp`, sdpFile);
    return `tmp/sdp/${id}.sdp`;
  };

  private async startMediaServer() {
    this.app.listen(process.env.MEDIASERVER_PORT || 4000, () => {
      console.log(
        `Media server is running on port ${
          process.env.MEDIASERVER_PORT || 4000
        }`,
      );
    });
    await this.runMediasoupWorker();
  }

  private startExpressServer() {
    if (!this.httpServer) throw new Error('Http server is not initialized');
    this.httpServer.listen(config.listenPort || 5000, () => {
      console.log(
        `Express server is running on port ${config.listenPort || 5000}`,
      );
    });
  }

  handleSendStream = (socket: Socket, data: { frame: string }) => {
    this.faceDetector.getPersonsAnalysis(data.frame).then((result) => {
      socket.emit('receive-stream', { data, result: JSON.stringify(result) });
    });
  };

  public async listen() {
    await this.startMediaServer();
  }
}
