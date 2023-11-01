/* eslint-disable @typescript-eslint/indent */
import express, { Application } from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';

import * as middlewares from './middlewares';
import MessageResponse from './interfaces/MessageResponse';
import { Server as SocketIOServer } from 'socket.io';
import { createServer, Server as HTTPSServer } from 'https';
import { createServer as createHttpServer, Server as HTTPServer } from 'http';
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
import { deleteSdpFile } from './engine/transcoder';
import Humanizer from './engine/humanizer';
// import { StreamInput } from 'fluent-ffmpeg-multistream';

require('dotenv').config();

export class Server {
  private app: Application = express();

  private httpServer: HTTPServer | HTTPSServer | undefined;

  private io: SocketIOServer | undefined;

  private workers: Worker[] = new Array<Worker>();

  private routers: Map<string, Router> = new Map<string, Router>();

  private producersTransport = new Map<string, Transport>();

  private consumersTransport = new Map<string, Transport>();

  private producers = new Map<string, Producer>();

  private consumers = new Map<string, Consumer>();

  private rtpTransports = new Map<string, PlainTransport>();

  private humanizers = new Map<string, Humanizer>();

  private activeSockets: string[] = [];

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
    this.handleSocket();
  }

  private initialize() {
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(morgan('dev'));
    this.app.use(helmet());
    this.app.use(
      cors({
        origin: ['http://localhost:4200'],
        methods: ['HEAD', 'GET', 'POST', 'PUT'],
      }),
    );
    this.app.use(express.json());
    this.app.use(middlewares.notFound);
    this.app.use(middlewares.errorHandler);

    const { useHttps, sslKey, sslCrt } = config;
    if (!useHttps) {
      this.httpServer = createHttpServer(this.app);
    } else {
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
    }

    this.startExpressServer();
    this.handleRoutes();
    this.io = new SocketIOServer(this.httpServer, {
      serveClient: true,
      cors: {
        origin: ['http://localhost:4200'],
        methods: ['HEAD', 'GET', 'POST'],
      },
    });
  }

  private handleRoutes() {
    this.app.get<{}, MessageResponse>('/', (req, res) => {
      res.json({
        message: '🦄🌈✨👋🌎🌍🌏✨🌈🦄',
      });
    });
    // this.app.use('/api/v1', api);
  }

  private handleSocket() {
    if (!this.io) throw new Error('Socket is not initialized');
    this.io.on('connection', async (socket) => {
      console.log(`#${socket.id}# connected.`);
      const room = (socket.handshake.query.room as string) || socket.id;
      socket.join(room);
      console.log(`#${socket.id}/${room}# connected.`);
      await this.createMediasoupRouterRoom(room);
      this.activeSockets.push(socket.id);
      socket.on('connect_error', (err) => {
        console.error(
          `#${socket.id}/${room}# connect_error due to ${err.message}`,
        );
      });

      socket.on('getRouterRtpCapabilities', (_, callback) => {
        if (!room) return callback({ error: 'Room is not defined' });
        const router = this.routers.get(room);
        if (!router) return;
        callback(router.rtpCapabilities);
      });

      socket.on('createProducerTransport', async (_, callback) => {
        if (!room) return callback({ error: 'Room is not defined' });
        try {
          const { transport, params } = await this.createWebRtcTransport(room);
          this.producersTransport.set(room, transport);
          callback(params);
        } catch (err: any) {
          console.error(err);
          callback({ error: err.message });
        }
      });

      socket.on('createConsumerTransport', async (_, callback) => {
        if (!room) return callback({ error: 'Room is not defined' });
        try {
          const { transport, params } = await this.createWebRtcTransport(room);
          this.consumersTransport.set(room, transport);
          callback(params);
        } catch (err: any) {
          console.error(err);
          callback({ error: err.message });
        }
      });

      socket.on('connectProducerTransport', async (data, callback) => {
        const { dtlsParameters } = data;
        if (!room) return callback({ error: 'Room is not defined' });
        const transport = this.producersTransport.get(room);
        if (!transport) return callback({ error: 'Transport is not defined' });
        await transport.connect({
          dtlsParameters,
        });
        callback({ connected: true });
      });

      socket.on('connectConsumerTransport', async (data, callback) => {
        const { dtlsParameters } = data;
        if (!room) return callback({ error: 'Room is not defined' });
        const transport = this.consumersTransport.get(room);
        if (!transport) return callback({ error: 'Transport is not defined' });
        await transport.connect({
          dtlsParameters,
        });
        callback({ connected: true });
      });

      socket.on('produce', async (data, callback) => {
        const { kind, rtpParameters } = data;
        if (!room) return callback({ error: 'Room is not defined' });
        const transport = this.producersTransport.get(room);
        if (!transport) return callback({ error: 'Transport is not defined' });
        const producer = await transport.produce({
          kind,
          rtpParameters,
        });
        this.producers.set(room, producer);
        callback({ id: producer.id });
      });

      socket.on('consume', async (data, callback) => {
        const { rtpCapabilities } = data;
        if (!room) return callback({ error: 'Room is not defined' });
        const producer = this.producers.get(room);
        if (!producer) return callback({ error: 'Producer is not defined' });
        callback(await this.createConsumer(room, producer, rtpCapabilities));
      });

      socket.on('initializeDetector', async (_, callback) => {
        if (!room) return callback({ error: 'Room is not defined' });
        const rtpVideoConsumer = await this.createRtpVideoConsumer(room);
        callback(rtpVideoConsumer.id);
      });
      socket.on('detect', async (_) => {
        const humanizerInstance = new Humanizer(6);
        this.humanizers.set(room, humanizerInstance);
        humanizerInstance.run(room, socket);
      });

      socket.on('disconnect', () => {
        socket.leave(room);
        this.activeSockets = this.activeSockets.filter(
          (existingSocket) => existingSocket !== socket.id,
        );
        this.closeStreams(room);
        console.log(`#${socket.id}/${room}# disconnected.`);
      });
    });
  }

  private async createMediasoupWorker() {
    const worker = await mediasoup.createWorker({
      logLevel: this.config.mediasoup.worker.logLevel,
      logTags: this.config.mediasoup.worker.logTags,
      rtcMinPort: this.config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: this.config.mediasoup.worker.rtcMaxPort,
    });

    if (!worker) throw new Error('Worker is not initialized');

    worker.on('died', () => {
      if (!worker) throw new Error('Worker is not initialized');
      console.error(
        'mediasoup worker died, exiting in 2 seconds... [pid:%d]',
        worker.pid,
      );
      setTimeout(() => process.exit(1), 2000);
    });

    this.workers.push(worker);
  }

  private async createMediasoupRouterRoom(roomGuid: string) {
    let worker = this.workers[0];
    if (!worker) {
      await this.createMediasoupWorker();
      worker = this.workers[0];
    }

    const mediaCodecs = this.config.mediasoup.router.mediaCodecs;
    const router = await worker.createRouter({ mediaCodecs });
    this.routers.set(roomGuid, router);
    return router;
  }

  private async createWebRtcTransport(roomGuid: string) {
    const { initialAvailableOutgoingBitrate } =
      this.config.mediasoup.webRtcTransport;

    const router = this.routers.get(roomGuid);
    if (!router) throw new Error('Router is not initialized');
    if (!this.config.mediasoup.webRtcTransport.listenIps)
      throw new Error('Listen ips is not initialized');
    const transport = await router.createWebRtcTransport({
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
    room: string,
    producer: Producer,
    rtpCapabilities: RtpCapabilities,
  ) {
    const router = this.routers.get(room);
    if (
      router &&
      !router.canConsume({
        producerId: producer.id,
        rtpCapabilities,
      })
    ) {
      console.error('can not consume');
      return false;
    }
    let consumer;
    try {
      const transport = this.consumersTransport.get(room);
      if (!transport) throw new Error('Consumer transport is not initialized');
      consumer = await transport.consume({
        producerId: producer.id,
        rtpCapabilities,
        paused: false,
      });

      this.consumers.set(room, consumer);

      if (consumer.type === 'simulcast') {
        await consumer.setPreferredLayers({
          spatialLayer: 2,
          temporalLayer: 2,
        });
      }
    } catch (error) {
      console.error('consume failed', error);
      return;
    }
    return {
      producerId: producer.id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused,
    };
  }

  async createRtpVideoConsumer(room: string) {
    const router = this.routers.get(room);
    if (!router) throw new Error('Router is not initialized');
    const rtpTransport = await router.createPlainTransport({
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

    const producer = this.producers.get(room);
    if (!producer) throw new Error('Producer is not initialized');
    const rtpVideoConsumer = await rtpTransport.consume({
      producerId: producer.id,
      rtpCapabilities: router.rtpCapabilities,
      paused: true,
    });

    this.rtpTransports.set(room, rtpTransport);

    const statsInterval = setInterval(() => {
      if (rtpVideoConsumer.closed) {
        clearInterval(statsInterval);
        return;
      }
      rtpVideoConsumer.getStats().then((stats) => {
        console.log('[VIDEO CONSUMER] RTP Plain Stats #', room, '#', stats);
      });
    }, 15000);

    await rtpVideoConsumer.resume();
    const sdpFileUri = this.createSdpFile(rtpTransport, room);
    console.log(`#${room}# SDP FILE URI`, sdpFileUri);
    return rtpVideoConsumer;
  }

  createSdpFile = (rtpTransport: PlainTransport, id: string) => {
    const sdpFile = `v=0
    o=- 0 0 IN IP4 ${rtpTransport.tuple.localIp}
    s=WebRTC_Room_${id}
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

  private closeStreams(room: string) {
    const humanizer = this.humanizers.get(room);
    if (humanizer) humanizer.close();

    const rtpTransport = this.rtpTransports.get(room);
    if (rtpTransport) rtpTransport.close();

    const consumer = this.consumers.get(room);
    if (consumer) consumer.close();

    const producer = this.producers.get(room);
    if (producer) producer.close();

    const router = this.routers.get(room);
    if (router) router.close();

    this.rtpTransports.delete(room);
    this.consumers.delete(room);
    this.producers.delete(room);
    this.routers.delete(room);
    deleteSdpFile(room);
    console.log(`#${room}# closed - All transports closed - SDP File Deleted`);
  }

  private async startMediaServer() {
    await this.createMediasoupWorker();
  }

  private startExpressServer() {
    if (!this.httpServer) throw new Error('Http server is not initialized');
    this.httpServer.listen(config.listenPort || 5000, () => {
      console.log(
        `Express server is running on port ${
          config.listenPort || 5000
        } - Using HTTPS: ${config.useHttps}`,
      );
    });
  }

  public async listen() {
    await this.startMediaServer();
  }
}
