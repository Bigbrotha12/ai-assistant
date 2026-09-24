final RegExp _nonWord = RegExp(r'[^\p{L}\p{N}]+', unicode: true);
final RegExp _whitespace = RegExp(r'\s+', unicode: true);
final RegExp _word = RegExp(r'[\p{L}\p{N}]', unicode: true);

const Map<int, String> _compatibility = <int, String>{
  0x00A0: ' ',
  0x00AA: 'a',
  0x00BA: 'o',
  0x2000: ' ',
  0x2001: ' ',
  0x2002: ' ',
  0x2003: ' ',
  0x2004: ' ',
  0x2005: ' ',
  0x2006: ' ',
  0x2007: ' ',
  0x2008: ' ',
  0x2009: ' ',
  0x200A: ' ',
  0x202F: ' ',
  0x205F: ' ',
  0x3000: ' ',
  0xFB00: 'ff',
  0xFB01: 'fi',
  0xFB02: 'fl',
  0xFB03: 'ffi',
  0xFB04: 'ffl',
  0xFB05: 'st',
  0xFB06: 'st',
  0x2160: 'I',
  0x2161: 'II',
  0x2162: 'III',
  0x2163: 'IV',
  0x2164: 'V',
  0x2165: 'VI',
  0x2166: 'VII',
  0x2167: 'VIII',
  0x2168: 'IX',
  0x2169: 'X',
  0x216A: 'XI',
  0x216B: 'XII',
  0x2126: 'Ω',
  0x212B: 'Å',
  0x216C: 'L',
  0x216D: 'C',
  0x216E: 'D',
  0x216F: 'M',
  0x2170: 'i',
  0x2171: 'ii',
  0x2172: 'iii',
  0x2173: 'iv',
  0x2174: 'v',
  0x2175: 'vi',
  0x2176: 'vii',
  0x2177: 'viii',
  0x2178: 'ix',
  0x2179: 'x',
  0x217A: 'xi',
  0x217B: 'xii',
  0x217C: 'l',
  0x217D: 'c',
  0x217E: 'd',
  0x217F: 'm',
  0x2460: '1',
  0x2461: '2',
  0x2462: '3',
  0x2463: '4',
  0x2464: '5',
  0x2465: '6',
  0x2466: '7',
  0x2467: '8',
  0x2468: '9',
  0x24B6: 'A',
  0x24B7: 'B',
  0x24B8: 'C',
  0x24B9: 'D',
  0x24BA: 'E',
  0x24BB: 'F',
  0x24BC: 'G',
  0x24BD: 'H',
  0x24BE: 'I',
  0x24BF: 'J',
  0x24C0: 'K',
  0x24C1: 'L',
  0x24C2: 'M',
  0x24C3: 'N',
  0x24C4: 'O',
  0x24C5: 'P',
  0x24C6: 'Q',
  0x24C7: 'R',
  0x24C8: 'S',
  0x24C9: 'T',
  0x24CA: 'U',
  0x24CB: 'V',
  0x24CC: 'W',
  0x24CD: 'X',
  0x24CE: 'Y',
  0x24CF: 'Z',
  0xFF10: '0',
  0xFF11: '1',
  0xFF12: '2',
  0xFF13: '3',
  0xFF14: '4',
  0xFF15: '5',
  0xFF16: '6',
  0xFF17: '7',
  0xFF18: '8',
  0xFF19: '9',
  0xFF1A: ':',
  0xFF1B: ';',
  0xFF1C: '<',
  0xFF1D: '=',
  0xFF1E: '>',
  0xFF1F: '?',
  0xFF20: '@',
  0xFF21: 'A',
  0xFF22: 'B',
  0xFF23: 'C',
  0xFF24: 'D',
  0xFF25: 'E',
  0xFF26: 'F',
  0xFF27: 'G',
  0xFF28: 'H',
  0xFF29: 'I',
  0xFF2A: 'J',
  0xFF2B: 'K',
  0xFF2C: 'L',
  0xFF2D: 'M',
  0xFF2E: 'N',
  0xFF2F: 'O',
  0xFF30: 'P',
  0xFF31: 'Q',
  0xFF32: 'R',
  0xFF33: 'S',
  0xFF34: 'T',
  0xFF35: 'U',
  0xFF36: 'V',
  0xFF37: 'W',
  0xFF38: 'X',
  0xFF39: 'Y',
  0xFF3A: 'Z',
  0xFF3B: '[',
  0xFF3C: '\\',
  0xFF3D: ']',
  0xFF3E: '^',
  0xFF3F: '_',
  0xFF40: '`',
  0xFF41: 'a',
  0xFF42: 'b',
  0xFF43: 'c',
  0xFF44: 'd',
  0xFF45: 'e',
  0xFF46: 'f',
  0xFF47: 'g',
  0xFF48: 'h',
  0xFF49: 'i',
  0xFF4A: 'j',
  0xFF4B: 'k',
  0xFF4C: 'l',
  0xFF4D: 'm',
  0xFF4E: 'n',
  0xFF4F: 'o',
  0xFF50: 'p',
  0xFF51: 'q',
  0xFF52: 'r',
  0xFF53: 's',
  0xFF54: 't',
  0xFF55: 'u',
  0xFF56: 'v',
  0xFF57: 'w',
  0xFF58: 'x',
  0xFF59: 'y',
  0xFF5A: 'z',
  0xFF5B: '{',
  0xFF5C: '|',
  0xFF5D: '}',
  0xFF5E: '~',
};

({String text, bool complete}) _normalizeCompatibility(String input) {
  final output = StringBuffer();
  var complete = true;
  for (final rune in input.runes) {
    final mapped = _compatibility[rune];
    if (mapped != null) {
      output.write(mapped);
      continue;
    }
    if (rune >= 0xFF01 && rune <= 0xFF5E) {
      output.writeCharCode(rune - 0xFEE0);
      continue;
    }
    if (rune >= 0x1D7CE && rune <= 0x1D7D7) {
      output.writeCharCode(0x30 + rune - 0x1D7CE);
      continue;
    }
    if (rune >= 0x2460 && rune <= 0x2473) {
      output.write('${rune - 0x245F}');
      continue;
    }
    if (rune >= 0x2474 && rune <= 0x2487) {
      output.write('${rune - 0x2473}');
      continue;
    }
    if (rune >= 0x2488 && rune <= 0x249B) {
      output.write('${rune - 0x2487}');
      continue;
    }
    if (rune >= 0x24B6 && rune <= 0x24CF) {
      output.writeCharCode(0x41 + rune - 0x24B6);
      continue;
    }
    if (rune >= 0x24D0 && rune <= 0x24E9) {
      output.writeCharCode(0x61 + rune - 0x24D0);
      continue;
    }
    final mathematical = _mathematicalAscii(rune);
    if (mathematical != null) {
      output.write(mathematical);
      continue;
    }
    final superOrSub = _superOrSubScript(rune);
    if (superOrSub != null) {
      output.write(superOrSub);
      continue;
    }
    if (_isPotentialCompatibilityRune(rune)) complete = false;
    output.writeCharCode(rune);
  }
  return (text: output.toString(), complete: complete);
}

String? _mathematicalAscii(int rune) {
  if (rune >= 0x1D400 && rune <= 0x1D419) {
    return String.fromCharCode(0x41 + rune - 0x1D400);
  }
  if (rune >= 0x1D41A && rune <= 0x1D433) {
    return String.fromCharCode(0x61 + rune - 0x1D41A);
  }
  if (rune >= 0x1D434 && rune <= 0x1D44D) {
    return String.fromCharCode(0x41 + rune - 0x1D434);
  }
  if (rune >= 0x1D44E && rune <= 0x1D467) {
    return String.fromCharCode(0x61 + rune - 0x1D44E);
  }
  if (rune >= 0x1D468 && rune <= 0x1D481) {
    return String.fromCharCode(0x41 + rune - 0x1D468);
  }
  if (rune >= 0x1D482 && rune <= 0x1D49B) {
    return String.fromCharCode(0x61 + rune - 0x1D482);
  }
  if (rune >= 0x1D49C && rune <= 0x1D4B5) {
    return String.fromCharCode(0x41 + rune - 0x1D49C);
  }
  if (rune >= 0x1D4B6 && rune <= 0x1D4CF) {
    return String.fromCharCode(0x61 + rune - 0x1D4B6);
  }
  if (rune >= 0x1D4D0 && rune <= 0x1D4E9) {
    return String.fromCharCode(0x41 + rune - 0x1D4D0);
  }
  if (rune >= 0x1D4EA && rune <= 0x1D503) {
    return String.fromCharCode(0x61 + rune - 0x1D4EA);
  }
  if (rune >= 0x1D504 && rune <= 0x1D51D) {
    return String.fromCharCode(0x41 + rune - 0x1D504);
  }
  if (rune >= 0x1D51E && rune <= 0x1D537) {
    return String.fromCharCode(0x61 + rune - 0x1D51E);
  }
  if (rune >= 0x1D538 && rune <= 0x1D551) {
    return String.fromCharCode(0x41 + rune - 0x1D538);
  }
  if (rune >= 0x1D552 && rune <= 0x1D56B) {
    return String.fromCharCode(0x61 + rune - 0x1D552);
  }
  if (rune >= 0x1D56C && rune <= 0x1D585) {
    return String.fromCharCode(0x41 + rune - 0x1D56C);
  }
  if (rune >= 0x1D586 && rune <= 0x1D59F) {
    return String.fromCharCode(0x61 + rune - 0x1D586);
  }
  if (rune >= 0x1D5A0 && rune <= 0x1D5B9) {
    return String.fromCharCode(0x41 + rune - 0x1D5A0);
  }
  if (rune >= 0x1D5BA && rune <= 0x1D5D3) {
    return String.fromCharCode(0x61 + rune - 0x1D5BA);
  }
  if (rune >= 0x1D5D4 && rune <= 0x1D5ED) {
    return String.fromCharCode(0x41 + rune - 0x1D5D4);
  }
  if (rune >= 0x1D5EE && rune <= 0x1D607) {
    return String.fromCharCode(0x61 + rune - 0x1D5EE);
  }
  if (rune >= 0x1D670 && rune <= 0x1D689) {
    return String.fromCharCode(0x41 + rune - 0x1D670);
  }
  if (rune >= 0x1D68A && rune <= 0x1D6A3) {
    return String.fromCharCode(0x61 + rune - 0x1D68A);
  }
  return null;
}

String? _superOrSubScript(int rune) {
  const superscripts = <int, String>{
    0x00B2: '2',
    0x00B3: '3',
    0x00B9: '1',
    0x2070: '0',
    0x2071: 'i',
    0x2074: '4',
    0x2075: '5',
    0x2076: '6',
    0x2077: '7',
    0x2078: '8',
    0x2079: '9',
    0x207A: '+',
    0x207B: '-',
    0x207C: '=',
    0x207D: '(',
    0x207E: ')',
    0x207F: 'n',
  };
  const subscripts = <int, String>{
    0x2080: '0',
    0x2081: '1',
    0x2082: '2',
    0x2083: '3',
    0x2084: '4',
    0x2085: '5',
    0x2086: '6',
    0x2087: '7',
    0x2088: '8',
    0x2089: '9',
  };
  return superscripts[rune] ?? subscripts[rune];
}

const Set<int> _supportedLatinCombiningMarks = <int>{
  0x0300,
  0x0301,
  0x0302,
  0x0303,
  0x0308,
  0x030A,
  0x0327,
};

bool _isPotentialCompatibilityRune(int rune) {
  if (rune >= 0x0300 && rune <= 0x036F) {
    return !_supportedLatinCombiningMarks.contains(rune);
  }
  if (rune == 0x00B5 || (rune >= 0x00BC && rune <= 0x00BE)) return true;
  if (rune >= 0x01C4 && rune <= 0x01CC) return true;
  if (rune >= 0x01F1 && rune <= 0x01F3) return true;
  if (rune >= 0x1100 && rune <= 0x11FF) return true;
  if (rune >= 0x2100 && rune <= 0x214F) return true;
  if (rune >= 0x2460 && rune <= 0x24FF) return true;
  if (rune >= 0x3300 && rune <= 0x33FF) return true;
  if (rune >= 0xA960 && rune <= 0xA97F) return true;
  if (rune >= 0xF900 && rune <= 0xFAFF) return true;
  if (rune >= 0x2F800 && rune <= 0x2FA1F) return true;
  if (rune >= 0xFB00 && rune <= 0xFB4F) return true;
  if (rune >= 0xFF61 && rune <= 0xFF9F) return true;
  if (rune >= 0x1D400 && rune <= 0x1D7FF) return true;
  if (rune >= 0x2070 && rune <= 0x209F) return true;
  if (rune >= 0xD7B0 && rune <= 0xD7FF) return true;
  return false;
}

const Map<String, String> _latinCompositions = <String, String>{
  'a\u0300': 'à',
  'a\u0301': 'á',
  'a\u0302': 'â',
  'a\u0303': 'ã',
  'a\u0308': 'ä',
  'a\u030a': 'å',
  'c\u0327': 'ç',
  'e\u0300': 'è',
  'e\u0301': 'é',
  'e\u0302': 'ê',
  'e\u0303': 'ẽ',
  'e\u0308': 'ë',
  'i\u0300': 'ì',
  'i\u0301': 'í',
  'i\u0302': 'î',
  'i\u0303': 'ĩ',
  'i\u0308': 'ï',
  'n\u0303': 'ñ',
  'o\u0300': 'ò',
  'o\u0301': 'ó',
  'o\u0302': 'ô',
  'o\u0303': 'õ',
  'o\u0308': 'ö',
  's\u0301': 'ś',
  'u\u0300': 'ù',
  'u\u0301': 'ú',
  'u\u0302': 'û',
  'u\u0303': 'ũ',
  'u\u0308': 'ü',
  'y\u0301': 'ý',
  'y\u0303': 'ỹ',
  'z\u0301': 'ź',
};

String _composeLatin(String input) {
  final runes = input.runes.toList();
  final output = StringBuffer();
  for (var index = 0; index < runes.length; index++) {
    if (index + 1 < runes.length) {
      final pair = String.fromCharCodes([runes[index], runes[index + 1]]);
      final composed = _latinCompositions[pair];
      if (composed != null) {
        output.write(composed);
        index++;
        continue;
      }
    }
    output.writeCharCode(runes[index]);
  }
  return output.toString();
}

class SentinelNormalizationResult {
  const SentinelNormalizationResult(this.text, {required this.complete});

  final String text;
  final bool complete;
}

SentinelNormalizationResult normalizeSentinelTextResult(String input) {
  final compatibility = _normalizeCompatibility(input);
  return SentinelNormalizationResult(
    _composeLatin(compatibility.text.toLowerCase())
        .replaceAll(_nonWord, ' ')
        .trim()
        .replaceAll(_whitespace, ' '),
    complete: compatibility.complete,
  );
}

String normalizeSentinelText(String input) =>
    normalizeSentinelTextResult(input).text;

bool _isWordCodeUnit(int codeUnit) {
  return _word.hasMatch(String.fromCharCode(codeUnit));
}

bool containsNormalizedPhrase(String text, String phrase) {
  final normalizedText = normalizeSentinelText(text);
  final normalizedPhrase = normalizeSentinelText(phrase);
  if (normalizedPhrase.isEmpty) return false;
  final textUnits = normalizedText.codeUnits;
  final phraseUnits = normalizedPhrase.codeUnits;
  var offset = 0;
  while (offset <= textUnits.length - phraseUnits.length) {
    final found = _indexOfUnits(textUnits, phraseUnits, offset);
    if (found < 0) return false;
    final before = found == 0 ? null : textUnits[found - 1];
    final afterIndex = found + phraseUnits.length;
    final after = afterIndex >= textUnits.length ? null : textUnits[afterIndex];
    if ((before == null || !_isWordCodeUnit(before)) &&
        (after == null || !_isWordCodeUnit(after))) {
      return true;
    }
    offset = found + 1;
  }
  return false;
}

int _indexOfUnits(List<int> text, List<int> phrase, int start) {
  if (phrase.isEmpty) return start;
  for (var i = start; i <= text.length - phrase.length; i++) {
    var matches = true;
    for (var j = 0; j < phrase.length; j++) {
      if (text[i + j] != phrase[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }
  return -1;
}
