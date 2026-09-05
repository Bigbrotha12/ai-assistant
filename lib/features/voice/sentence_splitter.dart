/// Assembles streamed LLM reply deltas into complete sentences for TTS.
///
/// Step one of sentence-buffered streaming TTS: instead of waiting for the
/// entire reply, the voice controller feeds each streamed delta into an
/// accumulator and dispatches closed sentences to synthesis as soon as their
/// terminal boundary arrives. That cuts time-to-first-audio from "whole reply
/// received" down to "first sentence complete".
///
/// Usage:
/// ```dart
/// final accumulator = SentenceAccumulator();
/// await for (final delta in replyStream) {
///   accumulator.add(delta);
///   for (final sentence in accumulator.takeCompleteSentences()) {
///     tts.speak(sentence); // dispatch as soon as the boundary closes
///   }
/// }
/// final tail = accumulator.takeRemainder(); // flush the trailing partial
/// if (tail != null) tts.speak(tail);
/// ```
///
/// ## Boundary rule (conservative, locked for Wave 1)
///
/// A sentence ends at `.`, `!`, or `?` — or at a newline — followed by
/// whitespace and then an uppercase letter or an opening quote
/// (`"`, `'`, `(`, `[`). A closing quote or bracket glued to the terminator
/// (`"Go!"`) joins the boundary cluster. The lookahead keeps abbreviations
/// ("e.g."), ordinals ("No. 5"), decimals ("3.14"), and ellipses ("...")
/// from splitting mid-sentence.
///
/// Newlines close the current sentence unconditionally — even without
/// terminal punctuation — so markdown line breaks become natural TTS pauses.
///
/// Consequences of the conservative rule (accepted for Wave 1): numbered
/// markdown list markers ("1. First item") split before the item text
/// because the marker period is followed by a capital, and a sentence whose
/// terminator is followed by lowercase text stays pending until a later
/// qualifying boundary (or the end-of-stream remainder) closes it.
final class SentenceAccumulator {
  /// Creates an empty accumulator; use one per streaming reply.
  SentenceAccumulator();

  /// Streamed text that has not yet been dispatched as a complete sentence.
  String _pending = '';

  /// Punctuation that can terminate a sentence.
  static const String _terminators = '.!?';

  /// Opening quotes/brackets that may start the next sentence right after a
  /// boundary without preventing the split.
  static const String _openers = '"\'([';

  /// Closing quotes/brackets that glue onto a terminator ("Go!") and stay
  /// with the sentence they close.
  static const String _closers = '"\')]';

  /// Appends a streamed [delta] to the pending buffer.
  ///
  /// Deltas may split anywhere — mid-word, mid-number, even between a
  /// terminator and its lookahead — because a boundary only counts once the
  /// character following it has arrived. Call [takeCompleteSentences] after
  /// each [add] to drain everything that has closed so far.
  void add(String delta) {
    if (delta.isEmpty) return;
    _pending += delta;
  }

  /// Drains every sentence whose terminating boundary has arrived.
  ///
  /// Returned sentences are trimmed, non-empty, and keep their terminating
  /// punctuation (plus any glued closing quote). Whitespace-only fragments
  /// never produce results. A terminator whose lookahead has not arrived yet
  /// stays pending until a later [add] confirms or refutes it.
  List<String> takeCompleteSentences() {
    final sentences = <String>[];
    final buffer = _pending;
    final length = buffer.length;
    var start = _skipWhitespace(buffer, 0);
    var i = start;
    while (i < length) {
      final char = buffer[i];

      // Newlines close a sentence even without terminal punctuation.
      if (char == '\n') {
        _emit(buffer, start, i, sentences);
        start = i = _skipWhitespace(buffer, i + 1);
        continue;
      }

      if (!_isTerminator(buffer, i)) {
        i++;
        continue;
      }

      // Absorb closing quotes/brackets glued to the terminator ("Go!").
      var clusterEnd = i + 1;
      while (clusterEnd < length && _closers.contains(buffer[clusterEnd])) {
        clusterEnd++;
      }
      if (clusterEnd >= length) break; // boundary not yet confirmed

      // Locked rule: whitespace, then an uppercase letter or opener. Only
      // spaces/tabs count as the separator here — a newline keeps its own
      // boundary role below.
      var next = clusterEnd;
      while (next < length && (buffer[next] == ' ' || buffer[next] == '\t')) {
        next++;
      }
      if (next >= length) break; // boundary not yet confirmed

      if (!_isUppercase(buffer[next]) && !_openers.contains(buffer[next])) {
        i++; // lookahead failed; not a boundary (e.g. "e.g.", "No. 5")
        continue;
      }

      _emit(buffer, start, clusterEnd, sentences);
      start = i = next;
    }
    _pending = start < length ? buffer.substring(start) : '';
    return sentences;
  }

  /// Returns the trailing partial sentence (trimmed) at end of stream.
  ///
  /// Returns null when nothing pends — e.g. right after a clean final
  /// boundary. The accumulator is empty afterwards.
  String? takeRemainder() {
    final remainder = _pending.trim();
    _pending = '';
    return remainder.isEmpty ? null : remainder;
  }

  /// Adds the trimmed slice [buffer.substring(start, end)] to [out] when it
  /// is non-empty, so whitespace-only chunks never emit results.
  void _emit(String buffer, int start, int end, List<String> out) {
    final sentence = buffer.substring(start, end).trim();
    if (sentence.isNotEmpty) out.add(sentence);
  }

  /// Whether [buffer] has a sentence terminator at [i].
  ///
  /// A `.` that belongs to a dot run ("...") never terminates, so ellipses
  /// cannot produce a split regardless of what follows.
  bool _isTerminator(String buffer, int i) {
    final char = buffer[i];
    if (!_terminators.contains(char)) return false;
    if (char == '.') {
      if (i > 0 && buffer[i - 1] == '.') return false;
      if (i + 1 < buffer.length && buffer[i + 1] == '.') return false;
    }
    return true;
  }

  /// Whether [char] is an uppercase letter (Unicode-aware, so digits and
  /// punctuation do not count — "No. 5" must not split).
  bool _isUppercase(String char) {
    final lower = char.toLowerCase();
    return lower != char && char.toUpperCase() == char;
  }

  /// First index at or after [from] that is not whitespace.
  int _skipWhitespace(String buffer, int from) {
    var i = from;
    while (i < buffer.length &&
        (buffer[i] == ' ' ||
            buffer[i] == '\t' ||
            buffer[i] == '\n' ||
            buffer[i] == '\r')) {
      i++;
    }
    return i;
  }
}
