import { Scene } from "../types";

/**
 * Convert seconds to SMPTE Timecode format HH:MM:SS:FF
 */
export function secondsToSMPTE(totalSeconds: number, fps: number = 24): string {
  if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = Math.floor(totalSeconds % 60);
  const frames = Math.floor((totalSeconds % 1) * fps);

  const hh = String(hours).padStart(2, "0");
  const mm = String(minutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const ff = String(frames).padStart(2, "0");

  return `${hh}:${mm}:${ss}:${ff}`;
}

/**
 * Generate a consistent, predictable filename for a scene based on its properties.
 */
export function getSceneFilename(scene: any, idx: number, consecutiveNumbering: boolean = false, overrideLetter?: string): string {
  const cleanTitle = (scene.text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 24)
    .replace(/^-|-$/g, "");
    
  const num = consecutiveNumbering 
    ? String(idx + 1).padStart(2, "0") 
    : (scene.sceneNumber || String(idx + 1));
    
  let letter = overrideLetter || "A";
  if (!overrideLetter && scene.imageVersions && scene.generatedImageUrl) {
    const active = scene.imageVersions.find((v: any) => v.url === scene.generatedImageUrl);
    if (active && active.letter) {
      letter = active.letter;
    }
  }

  return `cena-${num}_${letter}${cleanTitle ? `-${cleanTitle}` : ""}.png`;
}

/**
 * Convert SMPTE Timecode HH:MM:SS:FF to seconds
 */
export function smpteToSeconds(smpte: string, fps: number = 24): number {
  if (!smpte) return 0;
  const parts = smpte.split(":").map(Number);
  if (parts.length !== 4) return 0;
  const [h, m, s, f] = parts;
  return h * 3600 + m * 60 + s + f / fps;
}

/**
 * Format duration in seconds to human readable form (e.g. 5.8s)
 */
export function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds <= 0) return "0.0s";
  return `${seconds.toFixed(1)}s`;
}

/**
 * Format timestamp in MM:SS.s format without hours (e.g. 01:14.5)
 */
export function formatShortTimecode(totalSeconds: number): string {
  if (isNaN(totalSeconds) || totalSeconds < 0) totalSeconds = 0;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = seconds.toFixed(1).padStart(4, "0");
  return `${mm}:${ss}`;
}

/**
 * Parse MM:SS.s, MM:SS or decimal string back into total seconds
 */
export function parseShortTimecode(str: string): number {
  if (!str || typeof str !== "string") return 0;
  const clean = str.trim();
  if (clean.includes(":")) {
    const parts = clean.split(":");
    if (parts.length === 2) {
      const mins = parseFloat(parts[0]) || 0;
      const secs = parseFloat(parts[1]) || 0;
      return Math.max(0, Number((mins * 60 + secs).toFixed(2)));
    } else if (parts.length === 3) {
      const hrs = parseFloat(parts[0]) || 0;
      const mins = parseFloat(parts[1]) || 0;
      const secs = parseFloat(parts[2]) || 0;
      return Math.max(0, Number((hrs * 3600 + mins * 60 + secs).toFixed(2)));
    }
  }
  const directSecs = parseFloat(clean);
  return isNaN(directSecs) ? 0 : Math.max(0, Number(directSecs.toFixed(2)));
}

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

/**
 * Align word-level timestamps to an existing array of scenes without modifying scene text or scene count
 */
export function alignAudioToExistingScenes(scenes: Scene[], timedWords: TimedWord[]): Scene[] {
  if (!scenes || !Array.isArray(scenes) || scenes.length === 0) return scenes || [];
  if (!timedWords || !Array.isArray(timedWords) || timedWords.length === 0) {
    let head = 0;
    return scenes.map(s => {
      const start = s.startTime ?? head;
      const dur = s.duration && !isNaN(s.duration) ? s.duration : 3.0;
      const end = s.endTime ?? (start + dur);
      head = Math.max(start, end);
      return {
        ...s,
        startTime: Number(start.toFixed(2)),
        endTime: Number(end.toFixed(2)),
        duration: Math.max(0.5, Number((end - start).toFixed(2)))
      };
    });
  }

  const wordTokens = timedWords.map(tw => (tw && tw.word ? tw.word : "").toLowerCase().replace(/[^a-z0-9à-ú]/gi, ""));
  let lastMatchedIdx = 0;

  const mappedScenes = scenes.map((scene, sceneIdx) => {
    // If scene already has explicit fixed word indices, use them safely
    if (scene.wordStartIndex !== undefined && scene.wordEndIndex !== undefined &&
        timedWords[scene.wordStartIndex] && timedWords[scene.wordEndIndex]) {
      const startWord = timedWords[scene.wordStartIndex];
      const endWord = timedWords[scene.wordEndIndex];
      const startTimeRaw = (startWord && typeof startWord.start === "number") ? startWord.start : (scene.startTime ?? 0);
      const startTime = Math.max(0, startTimeRaw - 0.2);
      const endTime = (endWord && typeof endWord.end === "number") ? endWord.end : (scene.endTime ?? startTime + 3.0);
      const duration = Math.max(0.5, Number((endTime - startTime).toFixed(2)));
      lastMatchedIdx = Math.min(Math.max(0, scene.wordEndIndex + 1), Math.max(0, wordTokens.length - 1));
      return {
        ...scene,
        startTime: Number(startTime.toFixed(2)),
        endTime: Number(endTime.toFixed(2)),
        duration,
        timedWords: timedWords.slice(scene.wordStartIndex, scene.wordEndIndex + 1)
      };
    }

    const cleanSceneText = (scene.text || "").toLowerCase().replace(/[^a-z0-9à-ú\s]/gi, "");
    const sceneWords = cleanSceneText.split(/\s+/).filter(Boolean);

    if (sceneWords.length === 0) {
      const prevEnd = sceneIdx > 0 && scenes[sceneIdx - 1]?.endTime ? scenes[sceneIdx - 1].endTime! : 0;
      return {
        ...scene,
        startTime: Number((scene.startTime ?? prevEnd).toFixed(2)),
        endTime: Number((scene.endTime ?? (prevEnd + 3.0)).toFixed(2)),
        duration: Math.max(0.5, Number((scene.duration ?? 3.0).toFixed(2)))
      };
    }

    // N-Gram phrase matching for start of scene (8-word, 6-word, 4-word, 2-word, 1-word fallbacks)
    let startIdx = -1;
    const phraseLengths = [8, 6, 4, 2, 1];

    for (const pLen of phraseLengths) {
      if (startIdx !== -1) break;
      const phraseLen = Math.min(pLen, sceneWords.length);
      const startPhrase = sceneWords.slice(0, phraseLen).join(" ");
      for (let i = lastMatchedIdx; i <= wordTokens.length - phraseLen; i++) {
        if (wordTokens.slice(i, i + phraseLen).join(" ") === startPhrase) {
          startIdx = i;
          break;
        }
      }
    }

    if (startIdx === -1 || startIdx < 0 || startIdx >= wordTokens.length) {
      startIdx = Math.min(Math.max(0, lastMatchedIdx), Math.max(0, wordTokens.length - 1));
    }

    // Find endIdx using multi-word end phrase (8-word, 6-word, 4-word, 2-word, 1-word fallbacks)
    let endIdx = -1;
    const maxAllowedEndIdx = Math.min(wordTokens.length - 1, startIdx + sceneWords.length + 3);

    for (const pLen of phraseLengths) {
      if (endIdx !== -1) break;
      const endPhraseLen = Math.min(pLen, sceneWords.length);
      const endPhrase = sceneWords.slice(-endPhraseLen).join(" ");
      const expectedEndOffset = startIdx + sceneWords.length - 1;
      const searchRangeStart = Math.max(startIdx, expectedEndOffset - 4);
      const searchRangeEnd = Math.min(maxAllowedEndIdx, expectedEndOffset + 4);

      if (searchRangeEnd >= searchRangeStart) {
        for (let i = searchRangeStart; i <= searchRangeEnd; i++) {
          if (wordTokens.slice(i, i + endPhraseLen).join(" ") === endPhrase) {
            endIdx = i + endPhraseLen - 1;
            break;
          }
        }
      }
    }

    // Strict clamping: endIdx can NEVER exceed maxAllowedEndIdx (prevents bleeding into future scenes!)
    if (endIdx === -1 || endIdx < startIdx || endIdx > maxAllowedEndIdx) {
      endIdx = Math.min(startIdx + sceneWords.length - 1, maxAllowedEndIdx);
    }

    lastMatchedIdx = Math.min(endIdx + 1, Math.max(0, wordTokens.length - 1));

    const sceneStartWord = timedWords[startIdx];
    const sceneEndWord = timedWords[endIdx] || sceneStartWord;

    const startTimeRaw = (sceneStartWord && typeof sceneStartWord.start === "number") ? sceneStartWord.start : (scene.startTime ?? 0);
    const startTime = Math.max(0, startTimeRaw - 0.2);
    const endTime = (sceneEndWord && typeof sceneEndWord.end === "number") ? sceneEndWord.end : (scene.endTime ?? startTime + 3.0);
    const duration = Math.max(0.5, Number((endTime - startTime).toFixed(2)));

    const assignedWords = timedWords.slice(startIdx, endIdx + 1);

    return {
      ...scene,
      startTime: Number(startTime.toFixed(2)),
      endTime: Number(endTime.toFixed(2)),
      duration,
      wordStartIndex: startIdx,
      wordEndIndex: endIdx,
      timedWords: assignedWords
    };
  });

  let currentTimelineHead = 0;
  return mappedScenes.map(scene => {
    let rawStart = (typeof scene.startTime === "number" && !isNaN(scene.startTime)) ? scene.startTime : currentTimelineHead;
    if (rawStart < currentTimelineHead) {
      rawStart = currentTimelineHead;
    }
    let dur = (typeof scene.duration === "number" && !isNaN(scene.duration) && scene.duration > 0) ? scene.duration : 3.0;
    let rawEnd = (typeof scene.endTime === "number" && !isNaN(scene.endTime)) ? scene.endTime : (rawStart + dur);
    if (rawEnd <= rawStart) {
      rawEnd = rawStart + Math.max(0.5, dur);
    }
    currentTimelineHead = rawEnd;

    return {
      ...scene,
      startTime: Number(rawStart.toFixed(2)),
      endTime: Number(rawEnd.toFixed(2)),
      duration: Math.max(0.5, Number((rawEnd - rawStart).toFixed(2)))
    };
  });
}

/**
 * Recalculates timecodes when merging two adjacent scenes
 */
export function recalculateOnMerge(sceneA: Scene, sceneB: Scene): Partial<Scene> {
  const start = sceneA.startTime ?? 0;
  const end = sceneB.endTime ?? (start + (sceneA.duration || 3) + (sceneB.duration || 3));
  const duration = Math.max(0.5, Number((end - start).toFixed(2)));

  const combinedWords = [
    ...(sceneA.timedWords || []),
    ...(sceneB.timedWords || [])
  ];

  return {
    startTime: start,
    endTime: end,
    duration,
    timedWords: combinedWords
  };
}

/**
 * Generate Final Cut Pro / Premiere Pro / DaVinci Resolve XML (.xml)
 */
export function generateFCPXML(
  scenes: Scene[],
  audioFileName: string = "narration.mp3",
  fps: number = 24,
  projectName: string = "DiarioMaker Storyboard"
): string {
  const timebase = Math.round(fps);
  
  let maxEndTime = 0;
  scenes.forEach(s => {
    if (s.endTime && s.endTime > maxEndTime) maxEndTime = s.endTime;
  });
  if (maxEndTime === 0) maxEndTime = scenes.length * 4;

  const totalFrames = Math.round(maxEndTime * timebase);

  // 1. Pre-calculate bridged timecodes
  const bridgedScenes = scenes.map((scene, idx) => {
    let adjStartSec = scene.startTime ?? idx * 4;
    let adjEndSec = scene.endTime ?? (idx + 1) * 4;
    let hasCrossfade = false;

    // Look back
    if (idx > 0) {
      const prev = scenes[idx - 1];
      const prevOriginalEnd = prev.endTime ?? idx * 4;
      const gap = adjStartSec - prevOriginalEnd;
      if (gap >= 0 && gap <= 6.0) {
        adjStartSec = prevOriginalEnd + gap / 2;
      }
    }
    
    // Look forward
    if (idx < scenes.length - 1) {
      const next = scenes[idx + 1];
      const nextOriginalStart = next.startTime ?? (idx + 1) * 4;
      const gap = nextOriginalStart - adjEndSec;
      if (gap >= 0 && gap <= 6.0) {
        adjEndSec = adjEndSec + gap / 2;
        hasCrossfade = true;
      }
    }
    
    return { scene, idx, adjStartSec, adjEndSec, hasCrossfade };
  });

  // Build V1 and V2 tracks with 24-frame sequence overlap and Opacity keyframes for cross dissolve
  const v1Clips: string[] = [];
  const v2Clips: string[] = [];

  bridgedScenes.forEach((b, idx) => {
    const { scene, adjStartSec, adjEndSec, hasCrossfade } = b;
    let startFrame = Math.round(adjStartSec * timebase);
    let endFrame = Math.round(adjEndSec * timebase);

    // If this clip crossfades to the next clip, extend its end by 12 frames
    if (hasCrossfade) {
      endFrame += 12;
    }

    // If the PREVIOUS clip crossfaded into this clip, recede this clip's start by 12 frames
    const prevHasCrossfade = idx > 0 && bridgedScenes[idx - 1].hasCrossfade;
    if (prevHasCrossfade) {
      startFrame = Math.max(0, startFrame - 12);
    }

    const durationFrames = Math.max(1, endFrame - startFrame);
    const imageName = getSceneFilename(scene, idx);

    // Determine track: even index -> V1 (track 1), odd index -> V2 (track 2)
    const isV2 = idx % 2 === 1;

    // Opacity filter for V2 (top track):
    // If V2 is transitioning IN from V1: Fade IN 0% -> 100% over first 24 frames
    // If V2 is transitioning OUT to V1: Fade OUT 100% -> 0% over last 24 frames
    let opacityFilterXml = "";
    if (isV2 && (prevHasCrossfade || hasCrossfade)) {
      const fadeInXml = prevHasCrossfade ? `
                <keyframe>
                  <when>24</when>
                  <value>0</value>
                </keyframe>
                <keyframe>
                  <when>48</when>
                  <value>100</value>
                </keyframe>` : `
                <keyframe>
                  <when>24</when>
                  <value>100</value>
                </keyframe>`;

      const fadeOutXml = hasCrossfade ? `
                <keyframe>
                  <when>${24 + durationFrames - 24}</when>
                  <value>100</value>
                </keyframe>
                <keyframe>
                  <when>${24 + durationFrames}</when>
                  <value>0</value>
                </keyframe>` : "";

      opacityFilterXml = `
          <filter>
            <effect>
              <name>Opacity</name>
              <effectid>opacity</effectid>
              <effectcategory>opacity</effectcategory>
              <effecttype>opacity</effecttype>
              <mediatype>video</mediatype>
              <parameter>
                <parameterid>opacity</parameterid>
                <name>Opacity</name>
                <valuemin>0</valuemin>
                <valuemax>100</valuemax>${fadeInXml}${fadeOutXml}
              </parameter>
            </effect>
          </filter>`;
    }

    // Focal Point Center Keyframes (Smart Zoom)
    let centerParameterXml = "";
    if (scene.focalPoint) {
      centerParameterXml = `
              <parameter>
                <parameterid>center</parameterid>
                <name>Center</name>
                <keyframe>
                  <when>24</when>
                  <value>
                    <horiz>0</horiz>
                    <vert>0</vert>
                  </value>
                </keyframe>
                <keyframe>
                  <when>${24 + durationFrames}</when>
                  <value>
                    <horiz>${scene.focalPoint.x}</horiz>
                    <vert>${scene.focalPoint.y}</vert>
                  </value>
                </keyframe>
              </parameter>`;
    }

    const clipXml = `
        <clipitem id="clipitem-video-${idx + 1}">
          <name>${imageName}</name>
          <enabled>TRUE</enabled>
          <duration>${durationFrames + 48}</duration>
          <rate>
            <timebase>${timebase}</timebase>
            <ntsc>FALSE</ntsc>
          </rate>
          <start>${startFrame}</start>
          <end>${endFrame}</end>
          <in>24</in>
          <out>${24 + durationFrames}</out>
          <file id="file-image-${idx + 1}">
            <name>${imageName}</name>
            <pathurl>${imageName}</pathurl>
            <rate>
              <timebase>${timebase}</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <media>
              <video>
                <samplecharacteristics>
                  <width>1920</width>
                  <height>1080</height>
                </samplecharacteristics>
              </video>
            </media>
          </file>
          <filter>
            <effect>
              <name>Basic Motion</name>
              <effectid>basic</effectid>
              <effectcategory>motion</effectcategory>
              <effecttype>motion</effecttype>
              <mediatype>video</mediatype>
              <parameter>
                <parameterid>scale</parameterid>
                <name>Scale</name>
                <valuemin>0</valuemin>
                <valuemax>1000</valuemax>
                <keyframe>
                  <when>24</when>
                  <value>100</value>
                </keyframe>
                <keyframe>
                  <when>${24 + durationFrames}</when>
                  <value>127</value>
                </keyframe>
              </parameter>${centerParameterXml}
            </effect>
          </filter>${opacityFilterXml}
          <logginginfo>
            <scene>${idx + 1}</scene>
            <description>${(scene.description || "").replace(/["&<>]/g, "")}</description>
          </logginginfo>
        </clipitem>`;

    if (isV2) {
      v2Clips.push(clipXml);
    } else {
      v1Clips.push(clipXml);
    }
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${projectName.replace(/["&<>]/g, "")}</name>
    <duration>${totalFrames}</duration>
    <rate>
      <timebase>${timebase}</timebase>
      <ntsc>FALSE</ntsc>
    </rate>
    <timecode>
      <rate>
        <timebase>${timebase}</timebase>
        <ntsc>FALSE</ntsc>
      </rate>
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>1920</width>
            <height>1080</height>
            <pixelaspectratio>square</pixelaspectratio>
            <rate>
              <timebase>${timebase}</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
          </samplecharacteristics>
        </format>
        <track>
          ${v1Clips.join("\n")}
        </track>
        <track>
          ${v2Clips.join("\n")}
        </track>
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>48000</samplerate>
          </samplecharacteristics>
        </format>
        <track>
          <clipitem id="clipitem-audio-narration-1">
            <name>${audioFileName}</name>
            <enabled>TRUE</enabled>
            <duration>${totalFrames}</duration>
            <rate>
              <timebase>${timebase}</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <start>0</start>
            <end>${totalFrames}</end>
            <in>0</in>
            <out>${totalFrames}</out>
            <file id="file-audio-narration">
              <name>${audioFileName}</name>
              <pathurl>${audioFileName}</pathurl>
              <rate>
                <timebase>${timebase}</timebase>
                <ntsc>FALSE</ntsc>
              </rate>
              <media>
                <audio>
                  <samplecharacteristics>
                    <depth>16</depth>
                    <samplerate>48000</samplerate>
                  </samplecharacteristics>
                  <channelcount>2</channelcount>
                </audio>
              </media>
            </file>
            <sourcetrack>
              <mediatype>audio</mediatype>
              <trackindex>1</trackindex>
            </sourcetrack>
          </clipitem>
        </track>
        <track>
          <clipitem id="clipitem-audio-narration-2">
            <name>${audioFileName}</name>
            <enabled>TRUE</enabled>
            <duration>${totalFrames}</duration>
            <rate>
              <timebase>${timebase}</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <start>0</start>
            <end>${totalFrames}</end>
            <in>0</in>
            <out>${totalFrames}</out>
            <file id="file-audio-narration" />
            <sourcetrack>
              <mediatype>audio</mediatype>
              <trackindex>2</trackindex>
            </sourcetrack>
          </clipitem>
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>`;

  return xml;
}

/**
 * Generate VEGAS Pro Compatible XML (.xml)
 * Clean single-track XML optimized specifically for VEGAS Pro's Fcp7Importer script.
 */
export function generateVegasXML(
  scenes: Scene[],
  audioFileName: string = "narration.mp3",
  fps: number = 24,
  projectName: string = "DiarioMaker Storyboard"
): string {
  const timebase = Math.round(fps);
  
  let maxEndTime = 0;
  scenes.forEach(s => {
    if (s.endTime && s.endTime > maxEndTime) maxEndTime = s.endTime;
  });
  if (maxEndTime === 0) maxEndTime = scenes.length * 4;

  const totalFrames = Math.round(maxEndTime * timebase);

  // 1. Pre-calculate bridged timecodes
  const bridgedScenes = scenes.map((scene, idx) => {
    let adjStartSec = scene.startTime ?? idx * 4;
    let adjEndSec = scene.endTime ?? (idx + 1) * 4;
    let hasCrossfade = false;

    // Look back
    if (idx > 0) {
      const prev = scenes[idx - 1];
      const prevOriginalEnd = prev.endTime ?? idx * 4;
      const gap = adjStartSec - prevOriginalEnd;
      if (gap >= 0 && gap <= 6.0) {
        adjStartSec = prevOriginalEnd + gap / 2;
      }
    }
    
    // Look forward
    if (idx < scenes.length - 1) {
      const next = scenes[idx + 1];
      const nextOriginalStart = next.startTime ?? (idx + 1) * 4;
      const gap = nextOriginalStart - adjEndSec;
      if (gap >= 0 && gap <= 6.0) {
        adjEndSec = adjEndSec + gap / 2;
        hasCrossfade = true;
      }
    }
    
    return { scene, idx, adjStartSec, adjEndSec, hasCrossfade };
  });

  const videoClipsXml = bridgedScenes.map((b, idx) => {
    const { scene, adjStartSec, adjEndSec, hasCrossfade } = b;
    let startFrame = Math.round(adjStartSec * timebase);
    let endFrame = Math.round(adjEndSec * timebase);

    // Extend end by 12 frames if crossfading forward
    if (hasCrossfade) {
      endFrame += 12;
    }

    // Recede start by 12 frames if crossfading from previous clip
    const prevHasCrossfade = idx > 0 && bridgedScenes[idx - 1].hasCrossfade;
    if (prevHasCrossfade) {
      startFrame = Math.max(0, startFrame - 12);
    }

    const durationFrames = Math.max(1, endFrame - startFrame);
    const imageName = getSceneFilename(scene, idx);

    return `
        <clipitem id="clipitem-video-${idx + 1}">
          <name>${imageName}</name>
          <enabled>TRUE</enabled>
          <duration>${durationFrames}</duration>
          <rate>
            <timebase>${timebase}</timebase>
            <ntsc>FALSE</ntsc>
          </rate>
          <start>${startFrame}</start>
          <end>${endFrame}</end>
          <in>0</in>
          <out>${durationFrames}</out>
          <file id="file-image-${idx + 1}">
            <name>${imageName}</name>
            <pathurl>${imageName}</pathurl>
            <rate>
              <timebase>${timebase}</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <media>
              <video>
                <samplecharacteristics>
                  <width>1920</width>
                  <height>1080</height>
                </samplecharacteristics>
              </video>
            </media>
          </file>
          <effect>
            <name>Basic Motion</name>
            <effectid>basic</effectid>
            <effectcategory>motion</effectcategory>
            <effecttype>motion</effecttype>
            <mediatype>video</mediatype>
            <parameter>
              <parameterid>scale</parameterid>
              <name>Scale</name>
              <valuemin>0</valuemin>
              <valuemax>1000</valuemax>
              <keyframe>
                <when>0</when>
                <value>100</value>
              </keyframe>
              <keyframe>
                <when>${durationFrames}</when>
                <value>127</value>
              </keyframe>
            </parameter>
          </effect>
          <logginginfo>
            <scene>${idx + 1}</scene>
            <description>${(scene.description || "").replace(/["&<>]/g, "")}</description>
          </logginginfo>
        </clipitem>`;
  }).join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${projectName.replace(/["&<>]/g, "")}</name>
    <duration>${totalFrames}</duration>
    <rate>
      <timebase>${timebase}</timebase>
      <ntsc>FALSE</ntsc>
    </rate>
    <timecode>
      <rate>
        <timebase>${timebase}</timebase>
        <ntsc>FALSE</ntsc>
      </rate>
      <string>00:00:00:00</string>
      <frame>0</frame>
      <displayformat>NDF</displayformat>
    </timecode>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>1920</width>
            <height>1080</height>
            <pixelaspectratio>square</pixelaspectratio>
            <rate>
              <timebase>${timebase}</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
          </samplecharacteristics>
        </format>
        <track>
          ${videoClipsXml}
        </track>
      </video>
      <audio>
        <numOutputChannels>2</numOutputChannels>
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>48000</samplerate>
          </samplecharacteristics>
        </format>
        <track>
          <clipitem id="clipitem-audio-narration">
            <name>${audioFileName}</name>
            <enabled>TRUE</enabled>
            <duration>${totalFrames}</duration>
            <rate>
              <timebase>${timebase}</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <start>0</start>
            <end>${totalFrames}</end>
            <in>0</in>
            <out>${totalFrames}</out>
            <file id="file-audio-narration">
              <name>${audioFileName}</name>
              <pathurl>${audioFileName}</pathurl>
              <rate>
                <timebase>${timebase}</timebase>
                <ntsc>FALSE</ntsc>
              </rate>
              <media>
                <audio>
                  <samplecharacteristics>
                    <depth>16</depth>
                    <samplerate>48000</samplerate>
                  </samplecharacteristics>
                  <channelcount>2</channelcount>
                </audio>
              </media>
            </file>
            <effect>
              <name>Audio Levels</name>
              <effectid>audiolevels</effectid>
              <effectcategory>audiolevels</effectcategory>
              <effecttype>audiolevels</effecttype>
              <mediatype>audio</mediatype>
              <parameter>
                <parameterid>level</parameterid>
                <name>Level</name>
                <valuemin>0</valuemin>
                <valuemax>3.98109</valuemax>
                <value>1</value>
              </parameter>
            </effect>
          </clipitem>
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>`;

  return xml;
}

/**
 * Generate CMX 3600 EDL timeline format (.edl)
 */
export function generateEDL(
  scenes: Scene[],
  audioFileName: string = "narration.mp3",
  fps: number = 24,
  projectName: string = "DIARIO_MAKER"
): string {
  const cleanTitle = projectName.toUpperCase().replace(/[^A-Z0-9_]/g, "_").substring(0, 32);
  let edl = `TITLE: ${cleanTitle}\nFCM: NON-DROP FRAME\n\n`;

  let currentRecInFrames = 0;

  const bridgedScenes = scenes.map((scene, idx) => {
    let adjStartSec = scene.startTime ?? idx * 4;
    let adjEndSec = scene.endTime ?? (idx + 1) * 4;
    let hasCrossfade = false;

    if (idx > 0) {
      const prev = scenes[idx - 1];
      const prevOriginalEnd = prev.endTime ?? idx * 4;
      const gap = adjStartSec - prevOriginalEnd;
      if (gap >= 0 && gap <= 6.0) {
        adjStartSec = prevOriginalEnd + gap / 2;
      }
    }
    
    if (idx < scenes.length - 1) {
      const next = scenes[idx + 1];
      const nextOriginalStart = next.startTime ?? (idx + 1) * 4;
      const gap = nextOriginalStart - adjEndSec;
      if (gap >= 0 && gap <= 6.0) {
        adjEndSec = adjEndSec + gap / 2;
        hasCrossfade = true;
      }
    }
    
    return { scene, idx, adjStartSec, adjEndSec, hasCrossfade };
  });

  bridgedScenes.forEach((b) => {
    const { scene, idx, adjStartSec, adjEndSec } = b;
    const editNum = String(idx + 1).padStart(3, "0");
    const clipDurationSec = Math.max(0.1, adjEndSec - adjStartSec);
    const clipFrames = Math.round(clipDurationSec * fps);

    const srcInSMPTE = secondsToSMPTE(1.0, fps); // Start at 1.0s to give handles
    const srcOutSMPTE = secondsToSMPTE(1.0 + clipDurationSec, fps);

    const recInSMPTE = secondsToSMPTE(currentRecInFrames / fps, fps);
    currentRecInFrames += clipFrames;
    const recOutSMPTE = secondsToSMPTE(currentRecInFrames / fps, fps);

    const fullClipName = getSceneFilename(scene, idx);
    const reelName = fullClipName.substring(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "");

    const typeC = "C       ";
    edl += `${editNum}  ${reelName.padEnd(8, " ")} V     ${typeC} ${srcInSMPTE} ${srcOutSMPTE} ${recInSMPTE} ${recOutSMPTE}\n`;
    
    // If the PREVIOUS clip had a crossfade, we append the D line for THIS clip (standard EDL syntax)
    if (idx > 0 && bridgedScenes[idx - 1].hasCrossfade) {
       const typeD = "D    024";
       edl += `${editNum}  ${reelName.padEnd(8, " ")} V     ${typeD} ${srcInSMPTE} ${srcOutSMPTE} ${recInSMPTE} ${recOutSMPTE}\n`;
    }

    edl += `* FROM CLIP: ${fullClipName}\n`;
    edl += `* COMMENT: ${(scene.description || "").replace(/\n/g, " ").substring(0, 60)}\n\n`;
  });

  return edl;
}
