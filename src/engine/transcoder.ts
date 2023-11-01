import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import ffmpeg from 'fluent-ffmpeg';
ffmpeg.setFfmpegPath(ffmpegPath);
import fs from 'fs';

const VIDEO_OUTPUT_SIZE = '640x480';

export const getBaseFfmpegCommand = (sdpFileUri: string) => {
  if (checkSdpFileExsist(sdpFileUri)) {
    return ffmpeg(fs.createReadStream(`tmp/sdp/${sdpFileUri}.sdp`), {
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
        '0.1',
      ])
      .outputFPS(5);
  } else {
    return null;
  }
};

export const deleteSdpFile = (sdpFileUri: string) => {
  if (checkSdpFileExsist(sdpFileUri)) {
    return fs.unlink(`tmp/sdp/${sdpFileUri}.sdp`, (err) => {
      if (err) {
        console.error(err);
        return;
      }
    });
  }
  return false;
};

export const checkSdpFileExsist = (sdpFileUri: string) => {
  return fs.existsSync(`tmp/sdp/${sdpFileUri}.sdp`);
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
