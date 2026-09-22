import 'dart:convert';

import 'package:freezed_annotation/freezed_annotation.dart';
// ignore: unnecessary_import
import 'package:json_annotation/json_annotation.dart';

part 'message_model.freezed.dart';
part 'message_model.g.dart';

enum MessageRole { user, assistant, tool, system }

@freezed
abstract class ToolCall with _$ToolCall {
  const factory ToolCall({
    required String id,
    required String name,
    Map<String, dynamic>? args,
    String? result,
  }) = _ToolCall;

  factory ToolCall.fromJson(Map<String, dynamic> json) => _$ToolCallFromJson(json);
}

@freezed
abstract class Message with _$Message {
  // ignore: invalid_annotation_target
  @JsonSerializable(explicitToJson: true)
  const factory Message({
    required String id,
    required MessageRole role,
    required String content,
    String? toolCallId,
    List<ToolCall>? toolCalls,
    DateTime? createdAt,
  }) = _Message;

  factory Message.fromJson(Map<String, dynamic> json) => _$MessageFromJson(json);
}

@freezed
abstract class Conversation with _$Conversation {
  // ignore: invalid_annotation_target
  @JsonSerializable(explicitToJson: true)
  const factory Conversation({
    required String id,
    required String title,
    required List<Message> messages,
    required DateTime createdAt,
    required DateTime updatedAt,
  }) = _Conversation;

  factory Conversation.fromJson(Map<String, dynamic> json) =>
      _$ConversationFromJson(json);
}

/// Wire format for the OpenAI-compatible API. NOT persisted — maps domain
/// Message to the API message contract. `content` is a String for plain text
/// or a `List` of multimodal blocks (`{type: 'text'|'image_url', ...}`) for
/// vision messages.
class ApiMessage {
  final String role;
  final Object? content;
  final List<Map<String, dynamic>>? toolCalls;
  final String? toolCallId;

  const ApiMessage({
    required this.role,
    this.content,
    this.toolCalls,
    this.toolCallId,
  });
}

/// Builds API messages from domain messages, keeping assistant tool_calls and
/// their matching tool results as pairs. For assistant messages with toolCalls,
/// content is null. For tool messages, toolCallId is required.
List<ApiMessage> toApiMessages(List<Message> messages) {
  final result = <ApiMessage>[];
  for (final message in messages) {
    switch (message.role) {
      case MessageRole.system:
      case MessageRole.user:
        result.add(ApiMessage(role: message.role.name, content: message.content));
      case MessageRole.assistant:
        final toolCalls = message.toolCalls;
        if (toolCalls != null && toolCalls.isNotEmpty) {
          result.add(ApiMessage(
            role: 'assistant',
            content: null,
            toolCalls: toolCalls.map(_serializeToolCall).toList(),
          ));
        } else {
          result.add(
            ApiMessage(role: 'assistant', content: message.content),
          );
        }
      case MessageRole.tool:
        final toolCallId = message.toolCallId;
        if (toolCallId == null) {
          continue;
        }
        result.add(ApiMessage(
          role: 'tool',
          content: message.content,
          toolCallId: toolCallId,
        ));
    }
  }
  return result;
}

Map<String, dynamic> _serializeToolCall(ToolCall call) => {
      'id': call.id,
      'type': 'function',
      'function': {
        'name': call.name,
        'arguments': jsonEncode(call.args ?? const <String, dynamic>{}),
      },
    };

/// Expands `[file:<id>]` references in user messages by replacing them with
/// `[Image: <description>]` text using the provided [descriptions] map.
///
/// Only the first two file refs per message are expanded (to bound cost).
/// Returns a new list with new Message objects (content replaced only).
List<Message> expandFileRefs(List<Message> messages, Map<String, String> descriptions) {
  if (descriptions.isEmpty) return messages;
  final result = <Message>[];
  for (final m in messages) {
    if (m.role != MessageRole.user) {
      result.add(m);
      continue;
    }
    final content = m.content;
    final refRegex = RegExp(r'\[file:([^\]]+)\]');
    final matches = refRegex.allMatches(content).toList();
    if (matches.isEmpty) {
      result.add(m);
      continue;
    }
    // Only expand the first two refs.
    var count = 0;
    var expanded = content;
    for (final match in matches) {
      if (count >= 2) break;
      final id = match.group(1)!;
      final desc = descriptions[id];
      if (desc != null) {
        expanded = expanded.replaceFirst(
          '[file:$id]',
          '[Image: $desc]',
        );
        count++;
      }
    }
    result.add(m.copyWith(content: expanded));
  }
  return result;
}
