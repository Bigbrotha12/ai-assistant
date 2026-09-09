import 'dart:math';

import 'package:ai_assistant/features/chat/data/chat_client.dart';
import 'package:ai_assistant/features/chat/data/status_tracker.dart'
    show StatusTracker, statusPhraseForError, ackPhrases, stillWorkingPhrases,
    domainPhrases, defaultDomainPhrases, authErrorPhrases, serverErrorPhrases,
    networkErrorPhrases;
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('StatusTracker', () {
    group('onBackendAck', () {
      test('speaks exactly one ack phrase and displays Thinking…', () {
        final spoken = <String>[];
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: displays.add,
          random: Random(42),
        );

        tracker.onBackendAck();

        expect(spoken, hasLength(1));
        expect(ackPhrases, contains(spoken.first));
        expect(displays, ['Thinking…']);
        tracker.cancel();
      });

      test('second onBackendAck is ignored (idempotent)', () {
        final spoken = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: (_) {},
          random: Random(42),
        );

        tracker.onBackendAck();
        final countAfterFirst = spoken.length;
        tracker.onBackendAck();

        expect(spoken, hasLength(countAfterFirst));
        tracker.cancel();
      });
    });

    group('onContent', () {
      test('cancels still-working fallback when called before ack', () async {
        final spoken = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: (_) {},
          random: Random(42),
          stillWorkingDelay: Duration(milliseconds: 1),
        );

        tracker.onContent();
        await Future<void>.delayed(Duration(milliseconds: 20));

        expect(spoken, isEmpty);
        tracker.cancel();
      });

      test('cancels still-working fallback when called after ack', () async {
        final spoken = <String>[];
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: displays.add,
          random: Random(42),
          stillWorkingDelay: Duration(milliseconds: 1),
        );

        tracker.onBackendAck();
        tracker.onContent();
        await Future<void>.delayed(Duration(milliseconds: 20));

        final stillWorkingCount =
            spoken.where((p) => stillWorkingPhrases.contains(p)).length;
        expect(stillWorkingCount, 0);
        expect(displays.last, 'Responding…');
        tracker.cancel();
      });

      test('displays Responding…', () {
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: (_) {},
          onDisplay: displays.add,
        );

        tracker.onContent();
        expect(displays, ['Responding…']);
        tracker.cancel();
      });
    });

    group('still-working fallback', () {
      test('fires when nothing else happened', () async {
        final spoken = <String>[];
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: displays.add,
          random: Random(42),
          stillWorkingDelay: Duration(milliseconds: 1),
        );

        tracker.onBackendAck();
        await Future<void>.delayed(Duration(milliseconds: 20));

        expect(spoken, hasLength(2));
        expect(stillWorkingPhrases, contains(spoken.last));
        expect(displays.last, 'Working…');
        tracker.cancel();
      });
    });

    group('onToolCall domain resolution', () {
      test('task phrase via tool name', () {
        final spoken = <String>[];
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: displays.add,
          random: Random(42),
        );

        tracker.onToolCall('tasks_list_mcp_vikunja', '');

        expect(spoken, hasLength(1));
        expect(spoken.first, anyOf(domainPhrases['task']));
        expect(displays.last, startsWith('Working — '));
        tracker.cancel();
      });

      test('task phrase via argsSoFar', () {
        final spoken = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: (_) {},
          random: Random(42),
        );

        tracker.onToolCall(
          'invoke_tool_mcp_tool-discovery',
          '{"name":"tasks_list"}',
        );

        expect(spoken, hasLength(1));
        expect(spoken.first, anyOf(domainPhrases['task']));
        tracker.cancel();
      });

      test('recipe phrase', () {
        final spoken = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: (_) {},
          random: Random(42),
        );

        tracker.onToolCall('recipe_search', '');

        expect(spoken.first, anyOf(domainPhrases['recipe']));
        tracker.cancel();
      });

      test('game phrase', () {
        final spoken = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: (_) {},
          random: Random(42),
        );

        tracker.onToolCall('game_list', '');

        expect(spoken.first, anyOf(domainPhrases['game']));
        tracker.cancel();
      });

      test('search phrase', () {
        final spoken = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: (_) {},
          random: Random(42),
        );

        tracker.onToolCall('web_search', '');

        expect(spoken.first, anyOf(domainPhrases['search']));
        tracker.cancel();
      });

      test('default phrase for unknown domain', () {
        final spoken = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: (_) {},
          random: Random(42),
        );

        tracker.onToolCall('generic_tool', '');

        expect(spoken.first, anyOf(defaultDomainPhrases));
        tracker.cancel();
      });
    });

    group('onDisplay stage transitions', () {
      test('onBackendAck → Thinking…', () {
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: (_) {},
          onDisplay: displays.add,
        );

        tracker.onBackendAck();
        expect(displays.first, 'Thinking…');
        tracker.cancel();
      });

      test('onToolCall → starts with "Working — "', () {
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: (_) {},
          onDisplay: displays.add,
          random: Random(42),
        );

        tracker.onToolCall('tasks_list', '');
        expect(displays.first, startsWith('Working — '));
        tracker.cancel();
      });

      test('onContent → Responding…', () {
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: (_) {},
          onDisplay: displays.add,
        );

        tracker.onContent();
        expect(displays.first, 'Responding…');
        tracker.cancel();
      });
    });

    group('speak cap', () {
      test('>4 distinct tool phrases caps at 4 speaks', () {
        final spoken = <String>[];
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: displays.add,
          random: Random(42),
        );

        final toolNames = [
          'task_action',
          'recipe_action',
          'game_action',
          'search_action',
          'calendar_action',
        ];
        for (final name in toolNames) {
          tracker.onToolCall(name, '');
        }

        expect(spoken, hasLength(4));
        expect(displays, hasLength(5));
        tracker.cancel();
      });
    });

    group('deduplication', () {
      test('same tool phrase spoken once, displayed twice', () {
        final spoken = <String>[];
        final displays = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: displays.add,
          random: Random(42),
        );

        tracker.onToolCall('tasks_list', '');
        tracker.onToolCall('tasks_list', '');

        expect(spoken, hasLength(1));
        expect(displays, hasLength(2));
        tracker.cancel();
      });
    });

    group('cancel', () {
      test('stops pending timers', () async {
        final spoken = <String>[];
        final tracker = StatusTracker(
          onSpeak: spoken.add,
          onDisplay: (_) {},
          random: Random(42),
          stillWorkingDelay: Duration(milliseconds: 1),
        );

        tracker.onBackendAck();
        tracker.cancel();
        await Future<void>.delayed(Duration(milliseconds: 20));

        final stillWorkingCount =
            spoken.where((p) => stillWorkingPhrases.contains(p)).length;
        expect(stillWorkingCount, 0);
      });
    });
  });

  group('statusPhraseForError', () {
    test('auth error for ChatServerError 401', () {
      final phrases = [
        statusPhraseForError(
          ChatServerError('unauthorized', statusCode: 401),
          random: Random(42),
        ),
      ];
      expect(phrases.first, anyOf(authErrorPhrases));
    });

    test('auth error for ChatServerError 403', () {
      final phrase = statusPhraseForError(
        ChatServerError('forbidden', statusCode: 403),
        random: Random(42),
      );
      expect(phrase, anyOf(authErrorPhrases));
    });

    test('server error for ChatServerError 500', () {
      final phrase = statusPhraseForError(
        ChatServerError('internal', statusCode: 500),
        random: Random(42),
      );
      expect(phrase, anyOf(serverErrorPhrases));
    });

    test('network error for ChatNetworkError', () {
      final phrase = statusPhraseForError(
        ChatNetworkError('timeout'),
        random: Random(42),
      );
      expect(phrase, anyOf(networkErrorPhrases));
    });

    test('server error for plain Exception (fallback)', () {
      final phrase = statusPhraseForError(
        Exception('unknown'),
        random: Random(42),
      );
      expect(phrase, anyOf(serverErrorPhrases));
    });

    test('server error for ChatStreamError', () {
      final phrase = statusPhraseForError(
        ChatStreamError('stream broke'),
        random: Random(42),
      );
      expect(phrase, anyOf(serverErrorPhrases));
    });
  });
}
