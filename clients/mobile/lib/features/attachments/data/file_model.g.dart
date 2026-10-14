// GENERATED CODE - DO NOT MODIFY BY HAND

part of 'file_model.dart';

// **************************************************************************
// JsonSerializableGenerator
// **************************************************************************

_FileInfo _$FileInfoFromJson(Map<String, dynamic> json) => _FileInfo(
  id: json['id'] as String,
  filename: json['filename'] as String,
  sizeBytes: (json['sizeBytes'] as num).toInt(),
  mimeType: json['mimeType'] as String,
  uploadedAt: json['uploadedAt'] == null
      ? null
      : DateTime.parse(json['uploadedAt'] as String),
  cachedAt: json['cachedAt'] == null
      ? null
      : DateTime.parse(json['cachedAt'] as String),
  localPath: json['localPath'] as String?,
);

Map<String, dynamic> _$FileInfoToJson(_FileInfo instance) => <String, dynamic>{
  'id': instance.id,
  'filename': instance.filename,
  'sizeBytes': instance.sizeBytes,
  'mimeType': instance.mimeType,
  'uploadedAt': instance.uploadedAt?.toIso8601String(),
  'cachedAt': instance.cachedAt?.toIso8601String(),
  'localPath': instance.localPath,
};
