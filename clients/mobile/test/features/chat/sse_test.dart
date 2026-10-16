import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';

import 'package:ai_assistant/features/chat/data/sse.dart';

import 'sse_fixtures.dart';

Future<List<SseEvent>> collect(Stream<SseEvent> events) => events.toList();

void expectDone(SseEvent e, String? finishReason) {
  expect(e.type, SseEventType.done);
  expect(e.finishReason, finishReason);
}

/// Locates [needle] (a byte sequence) inside [haystack].
int indexOfBytes(List<int> haystack, List<int> needle) {
  for (var i = 0; i <= haystack.length - needle.length; i++) {
    var match = true;
    for (var j = 0; j < needle.length; j++) {
      if (haystack[i + j] != needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

void main() {
  group('content streaming', () {
    test('multiple content deltas concatenate into the full message', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: 'Hello')}\n\n'
            'data: ${chunk(content: ', wor')}\n\n'
            'data: ${chunk(content: 'ld!')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.content,
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(
        events
            .where((e) => e.type == SseEventType.content)
            .map((e) => e.content!)
            .join(),
        'Hello, world!',
      );
      expectDone(events.last, null);
    });

    test('reasoning_content is ignored while content still streams', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: 'Hello', reasoning: 'hidden reasoning')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(events.first.content, 'Hello');
    });

    test('<thinking> tags are stripped from content', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: '<thinking>Let me think...</thinking>Hello')}\n\n'
            'data: ${chunk(content: ' world')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(
        events
            .where((e) => e.type == SseEventType.content)
            .map((e) => e.content!)
            .join(),
        'Hello world',
      );
    });

    test('a content delta that is entirely <thinking> emits nothing', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: '<thinking>secret</thinking>')}\n\n'
            'data: ${chunk(content: 'answer')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(events.first.content, 'answer');
    });

    test('structured-output tool markers are stripped from content', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: 'Done. \ue202turn0search0')}\n\n'
            'data: ${chunk(content: 'Let me check that.')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(
        events
            .where((e) => e.type == SseEventType.content)
            .map((e) => e.content!)
            .join(),
        'Done. Let me check that.',
      );
    });

    test('a citation block with sentinels is stripped', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: 'Source: \ue200cite\ue202turn0file0\ue201')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(
        events
            .where((e) => e.type == SseEventType.content)
            .map((e) => e.content!)
            .join(),
        'Source: ',
      );
    });

    test('stripStructuredTokens is idempotent and safe on plain text', () {
      expect(stripStructuredTokens('Hello world'), 'Hello world');
      expect(stripStructuredTokens('a\ue202turn0search0b'), 'ab');
    });
  });

  group('termination', () {
    test('[DONE] produces a done event and stops', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: 'hi')}\n\n'
            'data: [DONE]\n\n'
            'data: ${chunk(content: 'ignored')}\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.done,
      ]);
      expectDone(events.last, null);
    });

    test('clean EOF without [DONE] produces a done event', () async {
      final events = await collect(
        parseSse(sseBytes('data: ${chunk(content: 'hi')}\n\n')),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.done,
      ]);
      expectDone(events.last, null);
    });

    test('empty stream produces a single done event', () async {
      final events = await collect(parseSse(const Stream.empty()));

      expect(events, hasLength(1));
      expectDone(events.single, null);
    });

    test(
      'finish_reason stop is sticky and the trailing [DONE] carries it',
      () async {
        final events = await collect(
          parseSse(
            sseBytes(
              'data: ${chunk(content: 'bye', finishReason: 'stop')}\n\n'
              'data: [DONE]\n\n',
            ),
          ),
        );

        expect(events.map((e) => e.type), [
          SseEventType.content,
          SseEventType.done,
        ]);
        expectDone(events.last, 'stop');
      },
    );
  });

  group('sticky finish_reason wire contract', () {
    test('tool-call stream yields every delta then one done(tool_calls)', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(
              toolCalls: [toolCall(index: 0, id: 'call_1', name: 'voices', arguments: '{"voice"')],
            )}\n\n'
            'data: ${chunk(toolCalls: [toolCall(index: 0, arguments: ':"amy"}')])}\n\n'
            'data: ${chunk(finishReason: 'tool_calls')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      // Both tool-call deltas stream before the single terminal done event;
      // the old parser returned early on the finish_reason chunk and would
      // have discarded nothing here, but the contract must explicitly allow
      // content/toolCall events AFTER a finish_reason chunk (see below).
      expect(events.map((e) => e.type), [
        SseEventType.toolCall,
        SseEventType.toolCall,
        SseEventType.done,
      ]);
      final args = events
          .where((e) => e.type == SseEventType.toolCall)
          .map((e) => e.toolCall!.argsFragment)
          .join();
      expect(args, '{"voice":"amy"}');
      final doneEvents = events
          .where((e) => e.type == SseEventType.done)
          .toList();
      expect(doneEvents, hasLength(1));
      expectDone(doneEvents.single, 'tool_calls');
    });

    test('a mid-stream finish_reason does not terminate the stream', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: 'first', finishReason: 'stop')}\n\n'
            'data: ${chunk(content: ' second')}\n\n'
            'data: ${chunk(content: ' third')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.content,
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(
        events
            .where((e) => e.type == SseEventType.content)
            .map((e) => e.content!)
            .join(),
        'first second third',
      );
      // The sticky reason is the one seen mid-stream, not overwritten by the
      // terminal [DONE] (which carries no reason).
      expectDone(events.last, 'stop');
    });

    test('[DONE] without a finish_reason carries the sticky one', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(finishReason: 'tool_calls')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events, hasLength(1));
      expectDone(events.single, 'tool_calls');
    });

    test('no finish_reason at all yields done(null)', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: 'hello')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.done,
      ]);
      expectDone(events.last, null);
    });

    test('an empty [DONE]-only stream yields a single done(null)', () async {
      final events = await collect(parseSse(sseBytes('data: [DONE]\n\n')));

      expect(events, hasLength(1));
      expectDone(events.single, null);
    });
  });

  group('tool calls', () {
    test('accumulates argument fragments across deltas', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(
              toolCalls: [toolCall(index: 0, id: 'call_1', name: 'voices', arguments: '{"voice"')],
            )}\n\n'
            'data: ${chunk(toolCalls: [toolCall(index: 0, arguments: ':"amy"}')])}\n\n'
            'data: ${chunk(finishReason: 'tool_calls')}\n\n',
          ),
        ),
      );

      expect(events, hasLength(3));

      final first = events[0];
      expect(first.type, SseEventType.toolCall);
      expect(first.toolCall!.index, 0);
      expect(first.toolCall!.id, 'call_1');
      expect(first.toolCall!.name, 'voices');
      expect(first.toolCall!.argsFragment, '{"voice"');

      final second = events[1];
      expect(second.type, SseEventType.toolCall);
      expect(second.toolCall!.id, isNull); // id/name only on the first fragment
      expect(second.toolCall!.name, isNull);
      expect(second.toolCall!.argsFragment, ':"amy"}');

      final args = events
          .where((e) => e.type == SseEventType.toolCall)
          .map((e) => e.toolCall!.argsFragment)
          .join();
      expect(args, '{"voice":"amy"}');

      expectDone(events.last, 'tool_calls');
    });

    test('re-prefixes a lost leading brace', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(
              toolCalls: [toolCall(index: 0, id: 'call_1', name: 'voices', arguments: '"voice"')],
            )}\n\n'
            'data: ${chunk(toolCalls: [toolCall(index: 0, arguments: ':"amy"}')])}\n\n'
            'data: ${chunk(finishReason: 'tool_calls')}\n\n',
          ),
        ),
      );

      final args = events
          .where((e) => e.type == SseEventType.toolCall)
          .map((e) => e.toolCall!.argsFragment)
          .join();
      expect(args, '{"voice":"amy"}');
      expectDone(events.last, 'tool_calls');
    });

    test('accumulates multiple tool calls by index independently', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(
              toolCalls: [toolCall(index: 0, id: 'call_a', name: 'voices', arguments: '{"v"')],
            )}\n\n'
            'data: ${chunk(
              toolCalls: [toolCall(index: 1, id: 'call_b', name: 'other', arguments: '{"x"')],
            )}\n\n'
            'data: ${chunk(toolCalls: [toolCall(index: 0, arguments: ':"amy"}')])}\n\n'
            'data: ${chunk(toolCalls: [toolCall(index: 1, arguments: ':1}')])}\n\n'
            'data: ${chunk(finishReason: 'tool_calls')}\n\n',
          ),
        ),
      );

      final byIndex = <int, String>{};
      for (final e in events) {
        if (e.type == SseEventType.toolCall) {
          byIndex[e.toolCall!.index] =
              (byIndex[e.toolCall!.index] ?? '') + e.toolCall!.argsFragment;
        }
      }
      expect(byIndex[0], '{"v":"amy"}');
      expect(byIndex[1], '{"x":1}');
    });

    test('a defining delta with id/name but no arguments still emits', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(
              toolCalls: [toolCall(index: 0, id: 'call_1', name: 'voices')],
            )}\n\n'
            'data: ${chunk(toolCalls: [toolCall(index: 0, arguments: '{"voice":"amy"}')])}\n\n'
            'data: ${chunk(finishReason: 'tool_calls')}\n\n',
          ),
        ),
      );

      final first = events[0];
      expect(first.type, SseEventType.toolCall);
      expect(first.toolCall!.id, 'call_1');
      expect(first.toolCall!.name, 'voices');
      expect(first.toolCall!.argsFragment, '');
      expect(events[1].toolCall!.argsFragment, '{"voice":"amy"}');
    });
  });

  group('robustness', () {
    test('comment and event lines are ignored', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            ': ping\n'
            ': keep-alive\n'
            'event: message\n'
            'data: ${chunk(content: 'hi')}\n\n'
            ': ping\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.done,
      ]);
    });

    test('error envelope produces an error event and stops', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: {"error": "upstream blew up"}\n\n'
            'data: ${chunk(content: 'ignored')}\n\n',
          ),
        ),
      );

      expect(events, hasLength(1));
      expect(events.single.type, SseEventType.error);
      expect(events.single.error, 'upstream blew up');
    });

    test('error envelope with a message map produces an error event', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: {"error": {"message": "boom", "type": "server_error"}}\n\n',
          ),
        ),
      );

      expect(events.single.type, SseEventType.error);
      expect(events.single.error, 'boom');
    });

    test(
      'error envelope followed by [DONE] yields one error and no done',
      () async {
        final events = await collect(
          parseSse(
            sseBytes(
              'data: {"error": "upstream blew up"}\n\n'
              'data: [DONE]\n\n',
            ),
          ),
        );

        expect(events, hasLength(1));
        expect(events.single.type, SseEventType.error);
        expect(events.single.error, 'upstream blew up');
        expect(events.where((e) => e.type == SseEventType.done), isEmpty);
      },
    );

    test('malformed JSON lines are skipped without crashing', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: {not valid json\n\n'
            'data: ${chunk(content: 'ok')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(events.first.content, 'ok');
    });

    test('non-object data payloads are skipped', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: 42\n\n'
            'data: null\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events, hasLength(1));
      expectDone(events.single, null);
    });

    test('tolerates CRLF line endings', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            'data: ${chunk(content: 'hi')}\r\n\r\n'
            'data: [DONE]\r\n\r\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(events.first.content, 'hi');
    });

    test('empty lines and empty payloads are ignored', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            '\n\n'
            'data: \n\n'
            'data: ${chunk(content: '')}\n\n'
            'data: ${chunk()}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [SseEventType.done]);
    });

    test('a partial line without a trailing newline is still parsed', () async {
      final events = await collect(
        parseSse(sseBytes('data: ${chunk(content: 'hi')}')),
      );

      expect(events.map((e) => e.type), [
        SseEventType.content,
        SseEventType.done,
      ]);
      expect(events.first.content, 'hi');
    });
  });

  group('utf-8 decoding', () {
    test(
      'a multi-byte character split across chunks decodes correctly',
      () async {
        final text = 'data: ${chunk(content: '中')}\n\ndata: [DONE]\n\n';
        final bytes = utf8.encode(text);
        final charBytes = utf8.encode('中');
        final at = indexOfBytes(bytes, charBytes);
        expect(at, greaterThanOrEqualTo(0));

        final events = await collect(parseSse(sseChunked(text, [at + 1])));

        expect(events.map((e) => e.type), [
          SseEventType.content,
          SseEventType.done,
        ]);
        expect(events.first.content, '中');
      },
    );

    test(
      'malformed UTF-8 bytes are replaced and do not crash the parser',
      () async {
        final events = await collect(
          parseSse(
            Stream.fromIterable([
              utf8.encode('data: ${chunk(content: 'ok')}\n\n'),
              [0xFF, 0xFE, 0x0A], // invalid bytes + newline
              utf8.encode(
                'data: ${chunk(content: 'after')}\n\ndata: [DONE]\n\n',
              ),
            ]),
          ),
        );

        expect(events.map((e) => e.type), [
          SseEventType.content,
          SseEventType.content,
          SseEventType.done,
        ]);
        expect(events[0].content, 'ok');
        expect(events[1].content, 'after');
      },
    );
  });

  group('input L1 advisory frame (§3.5)', () {
    // The exact §3.5 standalone frame, verbatim: a finding turn leads with it,
    // and because it carries neither `choices` nor `error` it must be parsed as
    // an advisory — not ignored like other unknown frames (§3.5, §8.7–§8.8).
    const advisoryFrame =
        'data: {"sentinel":{"advisory":true,"categories":["jailbreak_attempt"],'
        '"severity":"high","matchedRules":["jailbreak_attempt.instruction_override"]}}\n\n';

    test(
      'the exact §3.5 frame yields a sentinel event before content',
      () async {
        final events = await collect(
          parseSse(
            sseBytes(
              '${advisoryFrame}data: ${chunk(content: 'Hello')}\n\n'
              'data: ${chunk(finishReason: 'stop')}\n\n'
              'data: [DONE]\n\n',
            ),
          ),
        );

        expect(events.map((e) => e.type), [
          SseEventType.sentinel,
          SseEventType.content,
          SseEventType.done,
        ]);

        final advisory = events.first.sentinel!;
        expect(advisory.categories, ['jailbreak_attempt']);
        expect(advisory.severity, 'high');
        expect(advisory.matchedRules, [
          'jailbreak_attempt.instruction_override',
        ]);
        expect(events[1].content, 'Hello');
        expectDone(events.last, 'stop');
      },
    );

    test(
      'a clean turn emits no sentinel event and [DONE] is unchanged',
      () async {
        final events = await collect(
          parseSse(
            sseBytes(
              'data: ${chunk(content: 'Hello')}\n\n'
              'data: ${chunk(finishReason: 'stop')}\n\n'
              'data: [DONE]\n\n',
            ),
          ),
        );

        expect(events.map((e) => e.type), [
          SseEventType.content,
          SseEventType.done,
        ]);
        expect(events.where((e) => e.type == SseEventType.sentinel), isEmpty);
        expectDone(events.last, 'stop');
      },
    );

    test(
      'a frame with neither choices, error, nor sentinel is ignored',
      () async {
        final events = await collect(
          parseSse(
            sseBytes(
              'data: {"usage":{"prompt_tokens":1}}\n\n'
              'data: ${chunk(content: 'Hello')}\n\n'
              'data: [DONE]\n\n',
            ),
          ),
        );

        expect(events.map((e) => e.type), [
          SseEventType.content,
          SseEventType.done,
        ]);
        expect(
          events.singleWhere((e) => e.type == SseEventType.content).content,
          'Hello',
        );
      },
    );
  });

  group('P5 two-phase advisory frames', () {
    test(
      'a legacy P3 frame without phase/source parses as a final L1 advisory',
      () async {
        final events = await collect(
          parseSse(
            sseBytes(
              '${frame(jsonEncode({
                'sentinel': {
                  'advisory': true,
                  'categories': ['jailbreak_attempt'],
                  'severity': 'high',
                  'matchedRules': ['jailbreak_attempt.instruction_override'],
                },
              }))}'
              'data: ${chunk(content: 'Hello')}\n\n'
              'data: [DONE]\n\n',
            ),
          ),
        );

        expect(events.first.type, SseEventType.sentinel);
        final advisory = events.first.sentinel!;
        expect(advisory.phase, SentinelPhase.l1);
        expect(advisory.isFinal, isTrue);
        expect(advisory.advisory, isTrue);
        expect(advisory.semanticAvailable, isFalse);
        expect(advisory.findings, isEmpty);
        expect(advisory.cannedResponseId, isNull);
      },
    );

    test('a phase-tagged L1 frame is provisional and derives categories/'
        'severity/matchedRules from its findings', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            '${frame(jsonEncode({
              'sentinel': {
                'phase': 'l1',
                'source': 'l1',
                'advisory': true,
                'findings': [
                  {'ruleId': 'jailbreak_attempt.instruction_override', 'category': 'jailbreak_attempt', 'severity': 'medium', 'source': 'l1'},
                  {'ruleId': 'violence.threat', 'category': 'violence', 'severity': 'high', 'source': 'l1'},
                ],
              },
            }))}'
            'data: ${chunk(content: 'Hello')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      final advisory = events.first.sentinel!;
      expect(advisory.phase, SentinelPhase.l1);
      expect(advisory.isFinal, isFalse);
      expect(advisory.advisory, isTrue);
      expect(advisory.categories, ['jailbreak_attempt', 'violence']);
      expect(advisory.severity, 'high');
      expect(advisory.matchedRules, [
        'jailbreak_attempt.instruction_override',
        'violence.threat',
      ]);
      expect(advisory.findings, hasLength(2));
      expect(advisory.findings.first.source, 'l1');
      expect(advisory.findings.first.confidence, isNull);
      expectDone(events.last, null);
    });

    test('a semantic frame parses phase/final/semanticAvailable/action and '
        'per-finding source + confidence', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            '${frame(jsonEncode({
              'sentinel': {
                'phase': 'semantic',
                'final': true,
                'source': 'semantic',
                'semanticAvailable': true,
                'advisory': true,
                'categories': ['violence'],
                'severity': 'high',
                'matchedRules': ['semantic.violence'],
                'findings': [
                  {'ruleId': 'semantic.violence', 'category': 'violence', 'severity': 'high', 'source': 'semantic', 'confidence': 0.91},
                ],
                'action': {'cannedResponseId': 'canned-1'},
              },
            }))}'
            'data: [DONE]\n\n',
          ),
        ),
      );

      final advisory = events.first.sentinel!;
      expect(advisory.phase, SentinelPhase.semantic);
      expect(advisory.isFinal, isTrue);
      expect(advisory.semanticAvailable, isTrue);
      expect(advisory.advisory, isTrue);
      expect(advisory.cannedResponseId, 'canned-1');
      expect(advisory.findings.single.source, 'semantic');
      expect(advisory.findings.single.confidence, closeTo(0.91, 1e-9));
    });

    test(
      'a semantic-clean frame (advisory:false) emits a clearing event',
      () async {
        final events = await collect(
          parseSse(
            sseBytes(
              '${frame(jsonEncode({
                'sentinel': {
                  'phase': 'semantic',
                  'final': true,
                  'source': 'semantic',
                  'semanticAvailable': true,
                  'advisory': false,
                  'categories': [],
                  'severity': null,
                  'matchedRules': [],
                  'findings': [],
                  'action': {'cannedResponseId': null},
                },
              }))}'
              'data: [DONE]\n\n',
            ),
          ),
        );

        final advisory = events.first.sentinel!;
        expect(advisory.phase, SentinelPhase.semantic);
        expect(advisory.advisory, isFalse);
        expect(advisory.isFinal, isTrue);
        expect(advisory.semanticAvailable, isTrue);
        expect(advisory.cannedResponseId, isNull);
      },
    );

    test('L1 then semantic before DONE yields both events and preserves '
        'choice/[DONE] handling', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            '${frame(jsonEncode({
              'sentinel': {'phase': 'l1', 'source': 'l1', 'advisory': true, 'findings': []},
            }))}'
            'data: ${chunk(content: 'Hello')}\n\n'
            '${frame(jsonEncode({
              'sentinel': {'phase': 'semantic', 'final': true, 'source': 'semantic', 'semanticAvailable': true, 'advisory': false, 'categories': [], 'severity': null, 'matchedRules': [], 'findings': []},
            }))}'
            'data: ${chunk(finishReason: 'stop')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.map((e) => e.type), [
        SseEventType.sentinel,
        SseEventType.content,
        SseEventType.sentinel,
        SseEventType.done,
      ]);
      expect(events[0].sentinel!.phase, SentinelPhase.l1);
      expect(events[2].sentinel!.phase, SentinelPhase.semantic);
      expect(events[2].sentinel!.advisory, isFalse);
      expectDone(events.last, 'stop');
    });

    test('a non-advisory L1 frame yields no advisory and does not consume the '
        'rest of the stream', () async {
      final events = await collect(
        parseSse(
          sseBytes(
            '${frame(jsonEncode({
              'sentinel': {'phase': 'l1', 'source': 'l1', 'advisory': false},
            }))}'
            'data: ${chunk(content: 'Hello')}\n\n'
            'data: [DONE]\n\n',
          ),
        ),
      );

      expect(events.where((e) => e.type == SseEventType.sentinel), isEmpty);
      expect(
        events.singleWhere((e) => e.type == SseEventType.content).content,
        'Hello',
      );
      expectDone(events.last, null);
    });
  });
}
