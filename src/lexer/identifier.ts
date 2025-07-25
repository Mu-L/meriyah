import { Chars } from '../chars';
import { Context } from '../common';
import { Errors, ParseError } from '../errors';
import { type Parser } from '../parser/parser';
import { getOwnProperty } from '../utilities';
import { descKeywordTable, Token } from './../token';
import { CharFlags, CharTypes, isIdentifierPart, isIdentifierStart, isIdPart } from './charClassifier';
import { advanceChar, consumePossibleSurrogatePair, toHex } from './common';

/**
 * Scans identifier
 * For identifier doesn't start with unicode escape, but might contain
 * unicode escape after the start.
 *
 * @param parser  Parser object
 * @param context Context masks
 */
export function scanIdentifier(parser: Parser, context: Context, isValidAsKeyword: 0 | 1): Token {
  while (isIdPart[advanceChar(parser)]);
  parser.tokenValue = parser.source.slice(parser.tokenIndex, parser.index);

  return parser.currentChar !== Chars.Backslash && parser.currentChar <= 0x7e
    ? (getOwnProperty(descKeywordTable, parser.tokenValue) ?? Token.Identifier)
    : scanIdentifierSlowCase(parser, context, 0, isValidAsKeyword);
}

/**
 * Scans unicode identifier
 * For identifier starts with unicode escape.
 *
 * @param parser  Parser object
 * @param context Context masks
 */
export function scanUnicodeIdentifier(parser: Parser, context: Context): Token {
  const cookedChar = scanIdentifierUnicodeEscape(parser);
  if (!isIdentifierStart(cookedChar)) parser.report(Errors.InvalidUnicodeEscapeSequence);
  parser.tokenValue = String.fromCodePoint(cookedChar);
  return scanIdentifierSlowCase(parser, context, /* hasEscape */ 1, CharTypes[cookedChar] & CharFlags.KeywordCandidate);
}

/**
 * Scans identifier slow case
 *
 * @param parser  Parser object
 * @param context Context masks
 * @param hasEscape True if contains a unicode sequence
 * @param isValidAsKeyword
 */
export function scanIdentifierSlowCase(
  parser: Parser,
  context: Context,
  hasEscape: 0 | 1,
  isValidAsKeyword: number,
): Token {
  let start = parser.index;

  while (parser.index < parser.end) {
    if (parser.currentChar === Chars.Backslash) {
      parser.tokenValue += parser.source.slice(start, parser.index);
      hasEscape = 1;
      const code = scanIdentifierUnicodeEscape(parser);
      if (!isIdentifierPart(code)) parser.report(Errors.InvalidUnicodeEscapeSequence);
      isValidAsKeyword = isValidAsKeyword && CharTypes[code] & CharFlags.KeywordCandidate;
      parser.tokenValue += String.fromCodePoint(code);
      start = parser.index;
    } else {
      const merged = consumePossibleSurrogatePair(parser);
      if (merged > 0) {
        if (!isIdentifierPart(merged)) {
          parser.report(Errors.IllegalCharacter, String.fromCodePoint(merged));
        }
        parser.currentChar = merged;
        parser.index++;
        parser.column++;
      } else if (!isIdentifierPart(parser.currentChar)) {
        // Stop
        break;
      }
      advanceChar(parser);
    }
  }

  if (parser.index <= parser.end) {
    parser.tokenValue += parser.source.slice(start, parser.index);
  }

  const { length } = parser.tokenValue;
  if (isValidAsKeyword && length >= 2 && length <= 11) {
    const token = getOwnProperty(descKeywordTable, parser.tokenValue);
    if (token === void 0) return Token.Identifier | (hasEscape ? Token.IsEscaped : 0);
    if (!hasEscape) return token;

    if (token === Token.AwaitKeyword) {
      // await is only reserved word in async functions or modules
      if ((context & (Context.Module | Context.InAwaitContext)) === 0) {
        return token | Token.IsEscaped;
      }
      return Token.EscapedReserved;
    }

    if (context & Context.Strict) {
      if (token === Token.StaticKeyword) {
        return Token.EscapedFutureReserved;
      }
      if ((token & Token.FutureReserved) === Token.FutureReserved) {
        return Token.EscapedFutureReserved;
      }
      if ((token & Token.Reserved) === Token.Reserved) {
        if (context & Context.AllowEscapedKeyword && (context & Context.InGlobal) === 0) {
          return token | Token.IsEscaped;
        } else {
          return Token.EscapedReserved;
        }
      }
      return Token.AnyIdentifier | Token.IsEscaped;
    }
    if (
      context & Context.AllowEscapedKeyword &&
      (context & Context.InGlobal) === 0 &&
      (token & Token.Reserved) === Token.Reserved
    ) {
      return token | Token.IsEscaped;
    }
    if (token === Token.YieldKeyword) {
      return context & Context.AllowEscapedKeyword
        ? Token.AnyIdentifier | Token.IsEscaped
        : context & Context.InYieldContext
          ? Token.EscapedReserved
          : token | Token.IsEscaped;
    }

    // async is not reserved; it can be used as a variable name
    // or statement label without restriction
    if (token === Token.AsyncKeyword) {
      // Escaped "async" such as \u0061sync can only be identifier
      // not as "async" keyword
      return Token.AnyIdentifier | Token.IsEscaped;
    }
    if ((token & Token.FutureReserved) === Token.FutureReserved) {
      // In non-strict mode, future reserved can be identifier.
      return token | Token.Contextual | Token.IsEscaped;
    }
    return Token.EscapedReserved;
  }
  return Token.Identifier | (hasEscape ? Token.IsEscaped : 0);
}

/**
 * Scans private name
 *
 * @param parser  Parser object
 */
export function scanPrivateIdentifier(parser: Parser): Token {
  let char = advanceChar(parser);
  // When nextChar is Backslash "\", it's
  // #\uXXXX unicode escaped private identifier.
  // Unicode escape is scanned next.
  if (char === Chars.Backslash) return Token.PrivateField;

  const merged = consumePossibleSurrogatePair(parser);
  if (merged) char = merged;
  if (!isIdentifierStart(char)) parser.report(Errors.MissingPrivateIdentifier);

  return Token.PrivateField;
}

/**
 * Scans unicode identifier
 *
 * @param parser  Parser object
 */
function scanIdentifierUnicodeEscape(parser: Parser): number {
  // Check for Unicode escape of the form '\uXXXX'
  // and return code point value if valid Unicode escape is found.
  if (parser.source.charCodeAt(parser.index + 1) !== Chars.LowerU) {
    parser.report(Errors.InvalidUnicodeEscapeSequence);
  }
  parser.currentChar = parser.source.charCodeAt((parser.index += 2));
  parser.column += 2;
  return scanUnicodeEscape(parser);
}

/**
 * Scans unicode escape value
 *
 * @param parser  Parser object
 */
function scanUnicodeEscape(parser: Parser): number {
  // Accept both \uXXXX and \u{XXXXXX}
  let codePoint = 0;
  const char = parser.currentChar;
  // First handle a delimited Unicode escape, e.g. \u{1F4A9}
  if (char === Chars.LeftBrace) {
    const begin = parser.index - 2;
    while (CharTypes[advanceChar(parser)] & CharFlags.Hex) {
      codePoint = (codePoint << 4) | toHex(parser.currentChar);
      if (codePoint > Chars.NonBMPMax)
        throw new ParseError(
          { index: begin, line: parser.line, column: parser.column },
          parser.currentLocation,
          Errors.UnicodeOverflow,
        );
    }

    // At least 4 characters have to be read
    if ((parser.currentChar as number) !== Chars.RightBrace) {
      throw new ParseError(
        { index: begin, line: parser.line, column: parser.column },
        parser.currentLocation,
        Errors.InvalidHexEscapeSequence,
      );
    }
    advanceChar(parser); // consumes '}'
    return codePoint;
  }

  if ((CharTypes[char] & CharFlags.Hex) === 0) parser.report(Errors.InvalidHexEscapeSequence); // first one is mandatory

  const char2 = parser.source.charCodeAt(parser.index + 1);
  if ((CharTypes[char2] & CharFlags.Hex) === 0) parser.report(Errors.InvalidHexEscapeSequence);
  const char3 = parser.source.charCodeAt(parser.index + 2);
  if ((CharTypes[char3] & CharFlags.Hex) === 0) parser.report(Errors.InvalidHexEscapeSequence);
  const char4 = parser.source.charCodeAt(parser.index + 3);
  if ((CharTypes[char4] & CharFlags.Hex) === 0) parser.report(Errors.InvalidHexEscapeSequence);

  codePoint = (toHex(char) << 12) | (toHex(char2) << 8) | (toHex(char3) << 4) | toHex(char4);

  parser.currentChar = parser.source.charCodeAt((parser.index += 4));
  parser.column += 4;
  return codePoint;
}
