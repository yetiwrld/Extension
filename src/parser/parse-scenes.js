import { fnv1a } from '../utils/hash.js';
import { normalizeNewlines, unique } from '../utils/text.js';
import { padSceneNumber } from '../utils/format.js';
import { parseReferenceList } from './reference-tokens.js';

/**
 * Scene document parser.
 *
 * A scene starts on a line that contains a bracketed scene marker, e.g.
 *   [Scene 1]   [Scene 01]   [Scene 001]   [Scene 10]   [scene 3: Harbour]
 * Everything until the next marker belongs to that scene. Lines beginning with
 * "Reference images:" (or "Reference image:", "References:", ...) are read as
 * reference lists and removed from the prompt; all other text is kept exactly.
 *
 * The parser never guesses: duplicate numbers, empty prompts and text that
 * cannot be assigned to a scene are reported as errors or warnings.
 */

// Optional markdown wrappers are tolerated: "**[Scene 01]**", "# [Scene 01]".
const SCENE_HEADER_PATTERN =
  /^[ \t]*[#>*_-]*[ \t]*\[[ \t]*scene[ \t]+(\d+)[ \t]*(?:[:|\-\u2013\u2014][ \t]*([^\]\n]*?))?[ \t]*\][ \t*_#]*(.*)$/i;

const REFERENCE_LINE_PATTERN =
  /^[ \t]*[*_]*[ \t]*(?:reference|references|ref|refs)(?:[ \t]+(?:images?|imgs?|files?|pictures?|photos?|assets?))?[ \t]*[*_]*[ \t]*:[ \t]*[*_]*(.*)$/i;

const BULLET_PATTERN = /^[ \t]*(?:[-*\u2022]|\d{1,2}[.)])[ \t]+(.+)$/;

const MAX_SCENE_NUMBER = 9999;

/**
 * @typedef {Object} ParsedReferenceToken
 * @property {string} raw       Text exactly as written by the user.
 * @property {string} name      Cleaned filename or bare name.
 * @property {'file'|'name'} kind
 * @property {string} key       Lower-case name, used for dedupe and overrides.
 * @property {number} line      1-based source line.
 *
 * @typedef {Object} ParsedScene
 * @property {string} id            Stable id derived from number, prompt and references.
 * @property {number} index         Position in the document (0-based).
 * @property {number} number        Scene number as an integer.
 * @property {string} numberLabel   Zero-padded label, e.g. "01".
 * @property {string} title         Optional title after the number, may be "".
 * @property {number} startLine     1-based line of the scene marker.
 * @property {string} prompt        Exact prompt text (reference lines removed, outer blank lines trimmed).
 * @property {string} rawBody       Body text exactly as written, including reference lines.
 * @property {string} promptHash    Hash of `prompt`, used to detect edited prompts.
 * @property {ParsedReferenceToken[]} referenceTokens
 *
 * @typedef {Object} ParseIssue
 * @property {string} code
 * @property {'error'|'warning'|'info'} severity
 * @property {string} message
 * @property {number|null} sceneNumber
 * @property {number|null} line
 *
 * @typedef {Object} ParseResult
 * @property {ParsedScene[]} scenes
 * @property {ParseIssue[]} errors     Blocking problems: the queue must not run.
 * @property {ParseIssue[]} warnings   Informational problems.
 * @property {string} preamble         Text before the first marker (ignored).
 */

/**
 * @param {string} input Full document text.
 * @returns {ParseResult}
 */
export function parseScenes(input) {
  const text = normalizeNewlines(input);
  const lines = text.split('\n');
  const headers = findSceneHeaders(lines);

  /** @type {ParseIssue[]} */
  const errors = [];
  /** @type {ParseIssue[]} */
  const warnings = [];

  const firstHeaderIndex = headers.length ? headers[0].index : lines.length;
  const preamble = lines.slice(0, firstHeaderIndex).join('\n').trim();
  if (preamble) {
    warnings.push(
      issue('PREAMBLE_IGNORED', 'warning', 'Text before the first [Scene N] marker is not part of any scene and will be ignored.', null, 1),
    );
  }

  if (headers.length === 0) {
    if (text.trim()) {
      errors.push(
        issue('NO_SCENES', 'error', 'No [Scene N] markers were found. Each scene must start with a line such as [Scene 01].', null, null),
      );
    }
    return { scenes: [], errors, warnings, preamble };
  }

  /** @type {ParsedScene[]} */
  const scenes = [];
  const firstLineByNumber = new Map();
  const firstSceneByPrompt = new Map();
  let previousNumber = null;
  let outOfOrderReported = false;

  headers.forEach((header, position) => {
    const nextHeader = headers[position + 1];
    const bodyEnd = nextHeader ? nextHeader.index : lines.length;
    const bodyLines = lines.slice(header.index + 1, bodyEnd);
    // Text that follows the marker on the same line is the first body line.
    const firstBodyLineNumber = header.inlineText ? header.index + 1 : header.index + 2;
    if (header.inlineText) {
      bodyLines.unshift(header.inlineText);
    }

    const { promptLines, referenceLines } = splitReferenceLines(bodyLines, firstBodyLineNumber);
    const prompt = trimOuterWhitespace(promptLines.join('\n'));

    const tokens = [];
    const seenKeys = new Set();
    for (const reference of referenceLines) {
      const parsed = parseReferenceList(reference.text);
      for (const token of parsed.tokens) {
        if (seenKeys.has(token.key)) continue;
        seenKeys.add(token.key);
        tokens.push({ ...token, line: reference.line });
      }
      for (const message of parsed.warnings) {
        warnings.push(issue('REFERENCE_UNREADABLE', 'warning', message, header.number, reference.line));
      }
    }

    const scene = {
      id: '',
      index: scenes.length,
      number: header.number,
      numberLabel: padSceneNumber(header.number),
      title: header.title,
      startLine: header.index + 1,
      prompt,
      rawBody: bodyLines.join('\n'),
      promptHash: fnv1a(prompt),
      referenceTokens: tokens,
    };
    scene.id = buildSceneId(scene);
    scenes.push(scene);

    if (header.number > MAX_SCENE_NUMBER) {
      errors.push(issue('SCENE_NUMBER_TOO_LARGE', 'error', `Scene number ${header.number} is too large (maximum ${MAX_SCENE_NUMBER}).`, header.number, scene.startLine));
    }

    if (firstLineByNumber.has(header.number)) {
      errors.push(
        issue(
          'DUPLICATE_SCENE_NUMBER',
          'error',
          `Scene ${scene.numberLabel} appears more than once (lines ${firstLineByNumber.get(header.number)} and ${scene.startLine}). Rename one of them.`,
          header.number,
          scene.startLine,
        ),
      );
    } else {
      firstLineByNumber.set(header.number, scene.startLine);
    }

    if (!prompt) {
      errors.push(
        issue('EMPTY_PROMPT', 'error', `Scene ${scene.numberLabel} has no prompt text. Add the image or video description under its marker.`, header.number, scene.startLine),
      );
    }

    if (previousNumber !== null && header.number <= previousNumber && !outOfOrderReported) {
      outOfOrderReported = true;
      warnings.push(
        issue('OUT_OF_ORDER', 'warning', `Scene ${scene.numberLabel} comes after a higher-numbered scene. The queue follows document order.`, header.number, scene.startLine),
      );
    } else if (previousNumber !== null && header.number > previousNumber + 1) {
      warnings.push(
        issue('NUMBER_GAP', 'info', `Scene numbers jump from ${previousNumber} to ${header.number}.`, header.number, scene.startLine),
      );
    }
    previousNumber = header.number;

    if (prompt) {
      if (firstSceneByPrompt.has(prompt)) {
        const firstNumber = firstSceneByPrompt.get(prompt);
        warnings.push(
          issue('DUPLICATE_PROMPT', 'warning', `Scene ${scene.numberLabel} has the same prompt as Scene ${padSceneNumber(firstNumber)}.`, header.number, scene.startLine),
        );
      } else {
        firstSceneByPrompt.set(prompt, header.number);
      }
    }
  });

  return { scenes, errors, warnings, preamble };
}

/** Headers are lines that match the marker pattern. Returned in document order. */
function findSceneHeaders(lines) {
  const headers = [];
  lines.forEach((line, index) => {
    const match = SCENE_HEADER_PATTERN.exec(line);
    if (!match) return;
    const { title: titleInside, text: trailing } = splitTrailingTitle(match[3] || '');
    headers.push({
      index,
      number: Number.parseInt(match[1], 10),
      title: (match[2] || titleInside || '').trim(),
      inlineText: trailing,
    });
  });
  return headers;
}

/**
 * Text after the closing bracket is either a title ("[Scene 2]: Vex arrives",
 * "**[Scene 10]** - Final shot") when it starts with a separator, or the first
 * line of the prompt ("[Scene 1] A harbour at dawn").
 */
function splitTrailingTitle(rest) {
  const trimmed = rest.replace(/[\s*_#]+$/, '').replace(/^[\s]+/, '');
  const separated = /^[:|\-\u2013\u2014]\s*(.*)$/.exec(trimmed);
  if (separated) {
    return { title: separated[1].replace(/^[*_]+|[*_]+$/g, '').trim(), text: '' };
  }
  return { title: '', text: trimmed };
}

/**
 * Separate reference lines from prompt lines.
 * A "Reference images:" line with nothing after the colon may be followed by a
 * bullet list; those bullets are consumed as references.
 */
function splitReferenceLines(bodyLines, firstBodyLineNumber) {
  const promptLines = [];
  const referenceLines = [];
  for (let i = 0; i < bodyLines.length; i += 1) {
    const match = REFERENCE_LINE_PATTERN.exec(bodyLines[i]);
    if (!match) {
      promptLines.push(bodyLines[i]);
      continue;
    }
    referenceLines.push({ text: match[1], line: firstBodyLineNumber + i });
    if (!match[1].trim()) {
      while (i + 1 < bodyLines.length) {
        const bullet = BULLET_PATTERN.exec(bodyLines[i + 1]);
        if (!bullet) break;
        i += 1;
        referenceLines.push({ text: bullet[1], line: firstBodyLineNumber + i });
      }
    }
  }
  return { promptLines, referenceLines };
}

/** Remove leading and trailing whitespace of the whole prompt only. */
function trimOuterWhitespace(text) {
  return text.replace(/^\s+/, '').replace(/\s+$/, '');
}

function buildSceneId(scene) {
  const referenceKey = unique(scene.referenceTokens.map((token) => token.key)).join('|');
  return `scene-${scene.number}-${fnv1a(`${scene.prompt}\u0001${referenceKey}`)}`;
}

function issue(code, severity, message, sceneNumber, line) {
  return { code, severity, message, sceneNumber, line };
}
