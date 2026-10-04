const path = require('path');

const VIDEO_EXTENSIONS = new Set([
    'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'f4v', 'mpeg', 'mpg', 'mpe',
    'ts', 'mts', 'm2ts', 'vob', 'ogv', '3gp', '3g2', 'asf', 'rm', 'rmvb', 'divx', 'mxf'
]);
const AUDIO_EXTENSIONS = new Set([
    'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'weba', 'wma', 'alac', 'aiff',
    'aif', 'ape', 'amr', 'mid', 'midi', 'mka', 'caf', 'ac3', 'dts', 'm4b'
]);
const SUBTITLE_EXTENSIONS = new Set(['vtt', 'srt', 'ass', 'ssa', 'sub']);
const CONTENT_TYPE = new Map([
    ['mp4', 'video/mp4'], ['m4v', 'video/mp4'], ['mov', 'video/quicktime'], ['mkv', 'video/x-matroska'],
    ['webm', 'video/webm'], ['avi', 'video/x-msvideo'], ['wmv', 'video/x-ms-wmv'], ['flv', 'video/x-flv'],
    ['f4v', 'video/mp4'], ['mpeg', 'video/mpeg'], ['mpg', 'video/mpeg'], ['mpe', 'video/mpeg'],
    ['ts', 'video/mp2t'], ['mts', 'video/mp2t'], ['m2ts', 'video/mp2t'], ['vob', 'video/mpeg'],
    ['ogv', 'video/ogg'], ['3gp', 'video/3gpp'], ['3g2', 'video/3gpp2'], ['asf', 'video/x-ms-asf'],
    ['rm', 'application/vnd.rn-realmedia'], ['rmvb', 'application/vnd.rn-realmedia'],
    ['divx', 'video/x-msvideo'], ['mxf', 'application/mxf'],
    ['mp3', 'audio/mpeg'], ['m4a', 'audio/mp4'], ['aac', 'audio/aac'], ['wav', 'audio/wav'],
    ['flac', 'audio/flac'], ['ogg', 'audio/ogg'], ['oga', 'audio/ogg'], ['opus', 'audio/ogg'],
    ['weba', 'audio/webm'], ['wma', 'audio/x-ms-wma'], ['alac', 'audio/mp4'], ['aiff', 'audio/aiff'],
    ['aif', 'audio/aiff'], ['ape', 'audio/ape'], ['amr', 'audio/amr'], ['mid', 'audio/midi'],
    ['midi', 'audio/midi'], ['mka', 'audio/x-matroska'], ['caf', 'audio/x-caf'], ['ac3', 'audio/ac3'],
    ['dts', 'audio/vnd.dts'], ['m4b', 'audio/mp4'],
]);

function extname(filePath = '') {
    const base = String(filePath || '').split(/[\\/]/).pop() || '';
    const idx = base.lastIndexOf('.');
    return idx > -1 ? base.slice(idx + 1).toLowerCase() : '';
}
function basenameNoExt(filePath = '') {
    const base = path.basename(String(filePath || ''));
    const idx = base.lastIndexOf('.');
    return idx > -1 ? base.slice(0, idx) : base;
}
function isMediaExt(ext) { return VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext); }
function isVideoExt(ext) { return VIDEO_EXTENSIONS.has(ext); }
function isAudioExt(ext) { return AUDIO_EXTENSIONS.has(ext); }
function isSubtitleExt(ext) { return SUBTITLE_EXTENSIONS.has(ext); }
function directMime(ext) { return CONTENT_TYPE.get(ext) || 'application/octet-stream'; }
function mediaContentType(ext) { return CONTENT_TYPE.get(ext) || 'application/octet-stream'; }

module.exports = {
    VIDEO_EXTENSIONS, AUDIO_EXTENSIONS, SUBTITLE_EXTENSIONS,
    extname, basenameNoExt, isMediaExt, isVideoExt, isAudioExt, isSubtitleExt,
    directMime, mediaContentType,
};
