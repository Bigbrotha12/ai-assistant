class _Unset {
  const _Unset();
}

const _unset = _Unset();

/// A single deferred memory persisted in the local database.
///
/// Deliberately a plain (non-freezed) class: it is never serialized over the
/// wire, so the codegen overhead of freezed is not justified.
class Memory {
  const Memory({
    required this.id,
    required this.content,
    this.source,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;

  /// The memory text, indexed by the FTS5 full-text search.
  final String content;

  /// Optional provenance, e.g. the originating conversation id or 'manual'.
  final String? source;

  final DateTime createdAt;

  /// Recency of the memory, used to date-weight search ranking.
  final DateTime updatedAt;

  Memory copyWith({
    String? content,
    Object? source = _unset,
    DateTime? updatedAt,
  }) =>
      Memory(
        id: id,
        content: content ?? this.content,
        source: source == _unset ? this.source : source as String?,
        createdAt: createdAt,
        updatedAt: updatedAt ?? this.updatedAt,
      );

  @override
  bool operator ==(Object other) =>
      other is Memory &&
      other.id == id &&
      other.content == content &&
      other.source == source &&
      other.createdAt == createdAt &&
      other.updatedAt == updatedAt;

  @override
  int get hashCode => Object.hash(id, content, source, createdAt, updatedAt);
}