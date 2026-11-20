#!/usr/bin/env bash
# Synthetic voice-recording fixtures for the playback matrix: what browsers and
# phones record or upload. No real voices. Needs ffmpeg with libflite, libopus,
# libmp3lame (Debian's ffmpeg has them). Re-run to regenerate.
set -euo pipefail
cd "$(dirname "$0")/../fixtures/originals"
F="ffmpeg -nostdin -hide_banner -v error -y"
TEXT="Happy birthday. We are all so proud of you. This message is a test of how recordings play on every phone and browser."
# 12 s of synthetic speech (flite) plus a quiet room tone, 48 kHz mono: the source for every format.
$F -f lavfi -i "flite=text='${TEXT}':voice=slt" -f lavfi -i "anoisesrc=d=14:a=0.003:c=pink" \
   -filter_complex "[0]aresample=48000,apad=whole_dur=12[v];[1]aresample=48000[n];[v][n]amix=inputs=2:duration=first,atrim=0:12" \
   -ac 1 -ar 48000 -c:a pcm_s16le ${TMPDIR:-/tmp}/pm-src.wav
# 60 s version for seeking: the speech four times with pauses.
$F -stream_loop 4 -i ${TMPDIR:-/tmp}/pm-src.wav -t 60 -c:a pcm_s16le ${TMPDIR:-/tmp}/pm-src60.wav
S=${TMPDIR:-/tmp}/pm-src.wav; L=${TMPDIR:-/tmp}/pm-src60.wav
# Chrome/Android MediaRecorder: Opus in WebM written live (no Duration, no Cues, unknown Segment size).
$F -i $S -c:a libopus -b:a 64k -f webm -live 1 -cluster_time_limit 1000 chrome-recorder.webm
$F -i $L -c:a libopus -b:a 64k -f webm -live 1 -cluster_time_limit 1000 chrome-recorder-60s.webm
# Firefox MediaRecorder: Opus in Ogg.
$F -i $S -c:a libopus -b:a 64k firefox-recorder.ogg
# Safari MediaRecorder: AAC in fragmented MP4 (timeslice chunks).
$F -i $S -c:a aac -b:a 64k -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 1000000 -f mp4 safari-recorder.mp4
# iPhone Voice Memos style: AAC-LC in M4A, moov at the end.
$F -i $S -c:a aac -b:a 64k -f ipod voice-memo.m4a
$F -i $L -c:a aac -b:a 64k -f ipod voice-memo-60s.m4a
# WhatsApp-style voice note: Opus in Ogg at a low rate.
$F -i $S -c:a libopus -b:a 24k -application voip whatsapp-note.opus
# Common uploads.
$F -i $S -c:a libmp3lame -b:a 96k upload.mp3
$F -i $S -ar 44100 -c:a pcm_s16le upload.wav
$F -i $S -ar 44100 -ac 2 -c:a flac upload-stereo.flac
$F -i $S -c:a aac -b:a 64k -f adts upload.aac
rm -f ${TMPDIR:-/tmp}/pm-src.wav ${TMPDIR:-/tmp}/pm-src60.wav
ls -l
