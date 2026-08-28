import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/notifications/notif_client.dart';
import 'package:ai_assistant/features/widgets/launcher_shortcuts.dart';

void main() {
  group('parseNtfyEvent', () {
    test('parses a message event', () {
      const line =
          '{"id":"abc","event":"message","topic":"mytopic","message":"Hello","title":"Hi","click":"https://example.com"}';
      final message = parseNtfyEvent(line);
      expect(message, isNotNull);
      expect(message!.topic, 'mytopic');
      expect(message.title, 'Hi');
      expect(message.body, 'Hello');
      expect(message.link, 'https://example.com');
    });

    test('returns null for control events', () {
      expect(parseNtfyEvent('{"id":"x","event":"open","topic":"mytopic"}'),
          isNull);
      expect(
          parseNtfyEvent('{"id":"x","event":"keepalive","topic":"mytopic"}'),
          isNull);
    });

    test('returns null for malformed or empty lines', () {
      expect(parseNtfyEvent(''), isNull);
      expect(parseNtfyEvent('not json'), isNull);
      expect(parseNtfyEvent('{'), isNull);
    });

    test('returns null when message and title are both empty', () {
      expect(
          parseNtfyEvent(
              '{"id":"x","event":"message","topic":"t","message":"","title":""}'),
          isNull);
    });

    test('topic defaults to empty string', () {
      final message = parseNtfyEvent(
          '{"id":"x","event":"message","message":"Hi","title":"T"}');
      expect(message, isNotNull);
      expect(message!.topic, '');
    });
  });

  group('launcher shortcut resolution', () {
    test('maps chat and voice URIs to targets', () {
      expect(targetForUri('aiassistant://open_chat'), LauncherShortcutTarget.chat);
      expect(targetForUri('aiassistant://open_voice'), LauncherShortcutTarget.voice);
    });

    test('returns null for unknown, malformed, or absent URIs', () {
      expect(targetForUri(null), isNull);
      expect(targetForUri('aiassistant://unknown'), isNull);
      expect(targetForUri('https://example.com'), isNull);
      expect(targetForUri(''), isNull);
    });
  });
}