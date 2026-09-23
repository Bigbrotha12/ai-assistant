import 'dart:async';
import 'dart:math';

import '../../plugins/data/managed_error_codes.dart';
import '../../plugins/data/plugin_http.dart';

import './chat_client.dart';

/// Phrase lists used by [StatusTracker] and [statusPhraseForError]. Exported
/// so tests can reference the production constants directly.
const ackPhrases = [
  'Got it — let me look into that.',
  'Okay, one moment — I\'m on it.',
  'Sure, let me take a look.',
  'On it — give me a second.',
];

const stillWorkingPhrases = [
  'Still working on that…',
  'This is taking a moment — nearly there…',
];

const domainPhrases = <String, List<String>>{
  'task': ['Let me check your task list…', 'Let me pull up your tasks…'],
  'recipe': [
    'Let me look through your recipe database…',
    'Let me search your recipes…',
  ],
  'meal': [
    'Let me look through your recipe database…',
    'Let me search your recipes…',
  ],
  'game': ['Looking through your game list…', 'Let me browse your games…'],
  'spiel': ['Looking through your game list…', 'Let me browse your games…'],
  'board': ['Looking through your game list…', 'Let me browse your games…'],
  'calendar': [
    'Let me check your calendar…',
    'Let me see what\'s on your calendar…',
  ],
  'event': [
    'Let me check your calendar…',
    'Let me see what\'s on your calendar…',
  ],
  'search': ['Let me look that up…', 'Let me search for that…'],
};

const defaultDomainPhrases = [
  'One moment — working on that…',
  'Just a sec — sorting that out…',
];

const authErrorPhrases = [
  'It looks like there\'s an issue with your authentication.',
  'I\'m having trouble authenticating — could you re-sign in?',
];

const serverErrorPhrases = [
  'There seems to be an issue on my side — please try again.',
  'My server hit a snag — can you try again?',
];

const networkErrorPhrases = [
  'I can\'t reach my server right now — please try again.',
  'It looks like I lost my server connection — please try again.',
];

const pendingErrorPhrases = [
  'A reply is already in progress…',
  'A reply is still being prepared…',
];

const domainKeywords = [
  'task',
  'recipe',
  'meal',
  'game',
  'spiel',
  'board',
  'calendar',
  'event',
  'search',
];

T _pick<T>(List<T> items, Random rng) => items[rng.nextInt(items.length)];

String _resolveDomain(String name, String argsSoFar) {
  final haystack = '$name$argsSoFar'.toLowerCase();
  for (final kw in domainKeywords) {
    if (haystack.contains(kw)) return kw;
  }
  return '';
}

class StatusTracker {
  factory StatusTracker({
    required void Function(String phrase) onSpeak,
    required void Function(String display) onDisplay,
    Random? random,
    Duration stillWorkingDelay = const Duration(seconds: 30),
  }) {
    return StatusTracker._(
      onSpeak: onSpeak,
      onDisplay: onDisplay,
      rng: random ?? Random(),
      stillWorkingDelay: stillWorkingDelay,
    );
  }

  StatusTracker._({
    required this._onSpeak,
    required this._onDisplay,
    required this._rng,
    required this._stillWorkingDelay,
  });

  final void Function(String phrase) _onSpeak;
  final void Function(String display) _onDisplay;
  final Random _rng;
  final Duration _stillWorkingDelay;

  Timer? _stillWorkingTimer;
  bool _ackSpoken = false;
  bool _contentStarted = false;
  bool _toolPhraseSpoken = false;
  int _spokenCount = 0;
  final Set<String> _spokenPhrases = {};
  final Map<String, String> _phraseByDomain = {};

  void onBackendAck() {
    if (_ackSpoken) return;
    _ackSpoken = true;

    final phrase = _pick(ackPhrases, _rng);
    _speakPhrase(phrase);
    _onDisplay('Thinking…');
    _scheduleStillWorking();
  }

  void onToolCall(String name, String argsSoFar) {
    final domain = _resolveDomain(name, argsSoFar);
    final phrases =
        domain.isEmpty ? defaultDomainPhrases : domainPhrases[domain]!;
    final phrase =
        _phraseByDomain.putIfAbsent(domain, () => _pick(phrases, _rng));

    _onDisplay('Working — $phrase');
    // One spoken interjection per turn: later tool calls (or domain flips
    // as args stream in) only update the display, so a multi-tool response
    // never produces a rapid burst of canned lines before the reply.
    if (_toolPhraseSpoken) return;
    _toolPhraseSpoken = true;
    _speakPhrase(phrase);

    _stillWorkingTimer?.cancel();
    _stillWorkingTimer = null;
  }

  void onContent() {
    _contentStarted = true;
    _stillWorkingTimer?.cancel();
    _stillWorkingTimer = null;
    _onDisplay('Responding…');
  }

  void cancel() {
    _stillWorkingTimer?.cancel();
    _stillWorkingTimer = null;
    _ackSpoken = false;
    _contentStarted = false;
    _toolPhraseSpoken = false;
    _spokenCount = 0;
    _spokenPhrases.clear();
    _phraseByDomain.clear();
  }

  void _speakPhrase(String phrase) {
    if (_spokenCount >= 4) return;
    if (_spokenPhrases.contains(phrase)) return;
    _spokenPhrases.add(phrase);
    _spokenCount++;
    _onSpeak(phrase);
  }

  void _scheduleStillWorking() {
    _stillWorkingTimer?.cancel();
    _stillWorkingTimer = Timer(_stillWorkingDelay, () {
      if (_contentStarted) return;
      if (_toolPhraseSpoken) return;
      if (_spokenCount >= 4) return;
      final phrase = _pick(stillWorkingPhrases, _rng);
      _speakPhrase(phrase);
      _onDisplay('Working…');
    });
  }
}

String statusPhraseForError(Object error, {Random? random}) {
  final rng = random ?? Random();
  if (error is ChatServerError) {
    if (error.statusCode == 401 || error.statusCode == 403) {
      return _pick(authErrorPhrases, rng);
    }
    return _pick(serverErrorPhrases, rng);
  }
  if (error is ChatNetworkError) {
    return _pick(networkErrorPhrases, rng);
  }
  if (error is PluginClientException) {
    // Defense-in-depth for a gateway 401 whose error envelope carries no
    // parseable auth code (`server_error` with statusCode 401): the code
    // match below stays primary, but a 401 status is itself a key rejection.
    if (error.statusCode == 401) {
      return _pick(authErrorPhrases, rng);
    }
    return switch (error.code) {
      ManagedErrorCodes.unauthorized ||
      ManagedErrorCodes.credentialsExpired ||
      ManagedErrorCodes.noCredentials =>
        _pick(authErrorPhrases, rng),
      ManagedErrorCodes.networkError ||
      ManagedErrorCodes.timeout ||
      ManagedErrorCodes.sessionMissing =>
        _pick(networkErrorPhrases, rng),
      ManagedErrorCodes.pendingTurnExists => _pick(pendingErrorPhrases, rng),
      // A cancelled managed turn is a silent finalization, never an error.
      ManagedErrorCodes.cancelled => '',
      // All other managed codes (and unknown wire codes) are server-ish.
      _ => _pick(serverErrorPhrases, rng),
    };
  }
  return _pick(serverErrorPhrases, rng);
}
