import * as mediasoup from 'mediasoup';

export const config: {
  listenIp: string;
  listenPort: number;
  sslCrt: string;
  sslKey: string;
  mediasoup: {
    worker: mediasoup.types.WorkerSettings;
    router: mediasoup.types.RouterOptions;
    webRtcTransport: mediasoup.types.WebRtcTransportOptions;
    plainTransport: mediasoup.types.PlainTransportOptions;
    recording: {
      ip: string;
      port: number;
      rtcpPort: number;
    };
  };
} = {
  listenIp: '0.0.0.0',
  listenPort: 5000,
  sslCrt: '/etc/ssl/private/cert.pem',
  sslKey: '/etc/ssl/private/private.key',
  mediasoup: {
    // Worker settings
    worker: {
      rtcMinPort: 10000,
      rtcMaxPort: 10100,
      logLevel: 'warn',
      logTags: [
        'info',
        'ice',
        'dtls',
        'rtp',
        'srtp',
        'rtcp',
        // 'rtx',
        // 'bwe',
        // 'score',
        // 'simulcast',
        // 'svc'
      ],
    },
    // Router settings
    router: {
      mediaCodecs: [
        // {
        //   kind: 'video',
        //   mimeType: 'video/H264',
        //   preferredPayloadType: 96,
        //   clockRate: 90000,
        //   parameters: {
        //     'level-asymmetry-allowed': 1,
        //     'packetization-mode': 1,
        //     'profile-level-id': '42e01f',
        //   },
        // },
        {
          kind: 'video',
          mimeType: 'video/VP8',
          preferredPayloadType: 97,
          clockRate: 90000,
        },
      ],
    },
    // WebRtcTransport settings
    webRtcTransport: {
      listenIps: [
        {
          ip: '127.0.0.1',
          announcedIp: undefined,
        },
      ],
      initialAvailableOutgoingBitrate: 1000000,
    },
    // PlainTransportOptions
    plainTransport: {
      listenIp: { ip: '127.0.0.1', announcedIp: undefined },
    },
    recording: {
      ip: '127.0.0.1',
      port: 5006,
      rtcpPort: 5007,
    },
  },
};
