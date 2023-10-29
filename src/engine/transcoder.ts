import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath(ffmpegPath);
import fs from 'fs';

const VIDEO_OUTPUT_SIZE = '320x240';

export const getBaseFfmpegCommand = (sdpFileUri: string) => {
  return ffmpeg(fs.createReadStream(sdpFileUri), {
    logger: console,
  })
    .inputOptions(['-protocol_whitelist', 'file,rtp,udp,pipe', '-f', 'sdp'])
    .on('start', (commandLine) => {
      console.log('Spawned Ffmpeg with command: ' + commandLine);
    })
    .on('codecData', (data) => {
      console.log('codecData', data);
    })
    .on('progress', (progress) => {
      console.log('progress', progress);
    })
    .outputOptions([
      '-c:v',
      'mjpeg',
      '-f',
      'image2pipe',
      '-preset',
      'ultrafast',
      '-s',
      VIDEO_OUTPUT_SIZE,
      '-q:v',
      '0.5',
    ])
    .outputFPS(10);
};

export const deleteSdpFile = (sdpFileUri: string) => {
  fs.unlink(sdpFileUri, (err) => {
    if (err) {
      console.error(err);
      return;
    }
    console.log(`[${sdpFileUri}] - Sdp file deleted.`);
  });
};

// .outputOptions([
//   '-preset',
//   'ultrafast',
//   '-f',
//   'image2',
//   '-pix_fmt',
//   'rgb24',
//   '-vcodec',
//   'png',
//   '-s',
//   VIDEO_OUTPUT_SIZE,
// ])
