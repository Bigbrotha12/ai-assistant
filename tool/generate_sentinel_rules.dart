import 'dart:convert';
import 'dart:io';

const List<int> _sha256Constants = <int>[
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
];

int _rotr(int value, int bits) {
  return ((value >> bits) | (value << (32 - bits))) & 0xffffffff;
}

String _sha256Hex(List<int> input) {
  final bytes = <int>[...input];
  final bitLength = bytes.length * 8;
  bytes.add(0x80);
  while (bytes.length % 64 != 56) {
    bytes.add(0);
  }
  final high = (bitLength >> 32) & 0xffffffff;
  final low = bitLength & 0xffffffff;
  for (var shift = 24; shift >= 0; shift -= 8) {
    bytes.add((high >> shift) & 0xff);
  }
  for (var shift = 24; shift >= 0; shift -= 8) {
    bytes.add((low >> shift) & 0xff);
  }

  final hash = <int>[
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ];
  final words = List<int>.filled(64, 0);
  for (var offset = 0; offset < bytes.length; offset += 64) {
    for (var i = 0; i < 16; i++) {
      final index = offset + i * 4;
      words[i] =
          (bytes[index] << 24) |
          (bytes[index + 1] << 16) |
          (bytes[index + 2] << 8) |
          bytes[index + 3];
    }
    for (var i = 16; i < 64; i++) {
      final a = words[i - 15];
      final b = words[i - 2];
      final s0 = _rotr(a, 7) ^ _rotr(a, 18) ^ (a >> 3);
      final s1 = _rotr(b, 17) ^ _rotr(b, 19) ^ (b >> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) & 0xffffffff;
    }
    var a = hash[0];
    var b = hash[1];
    var c = hash[2];
    var d = hash[3];
    var e = hash[4];
    var f = hash[5];
    var g = hash[6];
    var h = hash[7];
    for (var i = 0; i < 64; i++) {
      final s1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
      final choose = (e & f) ^ ((~e & 0xffffffff) & g);
      final temp1 =
          (h + s1 + choose + _sha256Constants[i] + words[i]) & 0xffffffff;
      final s0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
      final majority = (a & b) ^ (a & c) ^ (b & c);
      final temp2 = (s0 + majority) & 0xffffffff;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) & 0xffffffff;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) & 0xffffffff;
    }
    hash[0] = (hash[0] + a) & 0xffffffff;
    hash[1] = (hash[1] + b) & 0xffffffff;
    hash[2] = (hash[2] + c) & 0xffffffff;
    hash[3] = (hash[3] + d) & 0xffffffff;
    hash[4] = (hash[4] + e) & 0xffffffff;
    hash[5] = (hash[5] + f) & 0xffffffff;
    hash[6] = (hash[6] + g) & 0xffffffff;
    hash[7] = (hash[7] + h) & 0xffffffff;
  }
  return hash.map((value) => value.toRadixString(16).padLeft(8, '0')).join();
}

String _dartLiteral(String value) {
  return jsonEncode(value).replaceAll(r'$', r'\$');
}

void main() {
  final script = File(Platform.script.toFilePath());
  final root = script.parent.parent;
  final sourceFile = File('${root.path}/server/src/sentinel/rules.v1.json');
  final source = sourceFile.readAsStringSync();
  final parsed = jsonDecode(source) as Map<String, dynamic>;
  final version = parsed['version'];
  if (version is! String || version.trim().isEmpty) {
    throw StateError('rules.v1.json has no version');
  }
  final hash = _sha256Hex(utf8.encode(source));
  final jsonLiteral = jsonEncode(source);
  final tsFile = File('${root.path}/server/src/sentinel/rules.generated.ts');
  tsFile.writeAsStringSync(
    'export const SENTINEL_RULE_SET_VERSION = ${jsonEncode(version)};\n'
    'export const SENTINEL_RULE_SET_SOURCE_SHA256 = '
    '${jsonEncode(hash)};\n'
    'export const SENTINEL_RULE_SET_SOURCE_JSON = $jsonLiteral;\n',
  );
  final dartFile = File(
    '${root.path}/lib/features/sentinel/data/rules.generated.dart',
  );
  dartFile.writeAsStringSync(
    "import 'dart:convert';\n\n"
    "import '../types.dart';\n\n"
    'const generatedSentinelRuleSetVersion = ${jsonEncode(version)};\n'
    'const generatedSentinelRuleSetSourceSha256 = ${jsonEncode(hash)};\n'
    'const generatedSentinelRuleSetSourceJson = ${_dartLiteral(source)};\n\n'
    'SentinelRuleSet get generatedSentinelRuleSet =>\n'
    '    SentinelRuleSet.fromJson(jsonDecode(generatedSentinelRuleSetSourceJson));\n',
  );
  stdout.writeln('generated $hash ($version)');
}
