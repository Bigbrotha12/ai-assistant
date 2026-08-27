import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';

import 'package:ai_assistant/core/backend_settings.dart';
import 'package:ai_assistant/core/chat_client_provider.dart';
import 'package:ai_assistant/core/files_service.dart';
import 'package:ai_assistant/core/files_providers.dart';
import 'package:ai_assistant/core/probe_providers.dart';
import 'package:ai_assistant/core/settings_providers.dart';
import 'package:ai_assistant/features/attachments/attachment_picker.dart';
import 'package:ai_assistant/features/attachments/file_model.dart';
import 'package:ai_assistant/features/chat/chat_screen.dart';
import 'package:ai_assistant/features/chat/database_providers.dart';

import 'fakes.dart';

/// Scripted [ImagePicker] that never touches the platform.
class FakeImagePicker extends ImagePicker {
  FakeImagePicker({
    this.galleryAvailable = true,
    this.cameraAvailable = true,
    this.picked,
  });

  bool galleryAvailable;
  bool cameraAvailable;

  /// The image returned by [pickImage], or null to simulate a cancelled pick.
  XFile? picked;

  int pickCalls = 0;
  ImageSource? lastSource;

  @override
  bool supportsImageSource(ImageSource source) => switch (source) {
        ImageSource.gallery => galleryAvailable,
        ImageSource.camera => cameraAvailable,
      };

  @override
  Future<XFile?> pickImage({
    required ImageSource source,
    double? maxWidth,
    double? maxHeight,
    int? imageQuality,
    CameraDevice preferredCameraDevice = CameraDevice.rear,
    bool requestFullMetadata = true,
  }) async {
    pickCalls++;
    lastSource = source;
    return picked;
  }
}

/// Minimal [FilesClient] standing in for a configured files service.
class FakeFilesClient implements FilesClient {
  @override
  Future<FileInfo> uploadFile({
    required String path,
    required String filename,
    required int sizeBytes,
    required String mimeType,
    CancelToken? cancelToken,
    void Function(int sent, int total)? onProgress,
  }) =>
      throw UnimplementedError();

  @override
  Future<List<FileInfo>> listFiles() async => const [];

  @override
  Future<Uint8List> fetchFile(String fileId) => throw UnimplementedError();

  @override
  Future<void> deleteFile(String fileId) async {}
}

/// Owns the [AttachmentRow]'s controlled state so tests can observe how the
/// row mutates the selection.
class AttachmentRowHarness extends StatefulWidget {
  const AttachmentRowHarness({
    super.key,
    this.initial = const [],
    this.draftToJobId = const {},
    this.uploadStatus = const {},
    required this.picker,
    this.enabled = true,
  });

  final List<AttachmentDraft> initial;
  final Map<String, String> draftToJobId;
  final Map<String, UploadJobStatus> uploadStatus;
  final ImagePicker picker;
  final bool enabled;

  @override
  State<AttachmentRowHarness> createState() => _AttachmentRowHarnessState();
}

class _AttachmentRowHarnessState extends State<AttachmentRowHarness> {
  late List<AttachmentDraft> _attachments = List.of(widget.initial);
  late final ValueNotifier<Map<String, UploadJobStatus>> _uploadStatus =
      ValueNotifier(widget.uploadStatus);

  @override
  void dispose() {
    _uploadStatus.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      home: Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: AttachmentRow(
            attachments: _attachments,
            onChanged: (updated) => setState(() => _attachments = updated),
            uploadStatus: _uploadStatus,
            draftToJobId: widget.draftToJobId,
            picker: widget.picker,
            enabled: widget.enabled,
          ),
        ),
      ),
    );
  }
}

/// Minimal valid 1x1 transparent PNG (the well-known `kTransparentImage`).
const List<int> _pngBytes = [
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, //
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, //
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, //
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, //
  0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, //
  0x54, 0x78, 0x9C, 0x62, 0x00, 0x01, 0x00, 0x00, //
  0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, //
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, //
  0x42, 0x60, 0x82,
];

void main() {
  late Directory tempDir;
  late File pngFile;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('attachment_picker_test');
    pngFile = File('${tempDir.path}/photo.png');
    await pngFile.writeAsBytes(_pngBytes);
  });

  tearDown(() async {
    await tempDir.delete(recursive: true);
  });

  AttachmentDraft draft(String name) => AttachmentDraft(
        path: '${tempDir.path}/$name',
        filename: name,
        sizeBytes: 10,
        mimeType: 'image/png',
      );

  group('AttachmentRow', () {
    testWidgets('renders an image thumbnail and remove button per attachment',
        (tester) async {
      await tester.pumpWidget(AttachmentRowHarness(
        initial: [draft('photo.png'), draft('second.png')],
        picker: FakeImagePicker(),
      ));
      await tester.pump();

      expect(find.byType(AttachmentRow), findsOneWidget);
      expect(find.byType(Image), findsNWidgets(2));
      expect(find.byIcon(Icons.close), findsNWidgets(2));
      expect(find.byIcon(Icons.add), findsOneWidget);
    });

    testWidgets('tapping remove drops the attachment from the selection',
        (tester) async {
      await tester.pumpWidget(AttachmentRowHarness(
        initial: [draft('photo.png')],
        picker: FakeImagePicker(),
      ));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.close));
      await tester.pump();

      expect(find.byType(Image), findsNothing);
      expect(find.byIcon(Icons.close), findsNothing);
    });

    testWidgets('add button is disabled at the max of 5 files', (tester) async {
      final picker = FakeImagePicker();
      await tester.pumpWidget(AttachmentRowHarness(
        initial: [for (var i = 0; i < 5; i++) draft('$i.png')],
        picker: picker,
      ));
      await tester.pump();

      expect(find.byTooltip('Max 5 files per message'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.add));
      await tester.pump();

      expect(picker.pickCalls, 0);
    });

    testWidgets(
        'add button is disabled with a hint when the files service is not '
        'configured', (tester) async {
      final picker = FakeImagePicker();
      await tester.pumpWidget(AttachmentRowHarness(
        picker: picker,
        enabled: false,
      ));
      await tester.pump();

      expect(find.byTooltip('Files service not configured'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.add));
      await tester.pump();

      expect(picker.pickCalls, 0);
    });

    testWidgets('shows a hint when no image source is available',
        (tester) async {
      final picker = FakeImagePicker(
        galleryAvailable: false,
        cameraAvailable: false,
      );
      await tester.pumpWidget(AttachmentRowHarness(picker: picker));
      await tester.pump();

      expect(find.byTooltip('No files available'), findsOneWidget);
      await tester.tap(find.byIcon(Icons.add));
      await tester.pump();

      expect(picker.pickCalls, 0);
    });

    testWidgets('tapping add picks a gallery image and reports the draft',
        (tester) async {
      final picker = FakeImagePicker(picked: XFile(pngFile.path));
      await tester.pumpWidget(AttachmentRowHarness(picker: picker));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.add));
      await tester.pump();
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      await tester.pump();

      expect(picker.pickCalls, 1);
      expect(picker.lastSource, ImageSource.gallery);
      expect(find.byType(Image), findsOneWidget);
      expect(find.byIcon(Icons.close), findsOneWidget);
    });

    testWidgets('falls back to the camera when the gallery is unavailable',
        (tester) async {
      final picker = FakeImagePicker(
        galleryAvailable: false,
        cameraAvailable: true,
        picked: XFile(pngFile.path),
      );
      await tester.pumpWidget(AttachmentRowHarness(picker: picker));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.add));
      await tester.pump();

      expect(picker.pickCalls, 1);
      expect(picker.lastSource, ImageSource.camera);
    });

    testWidgets('a cancelled pick leaves the selection unchanged',
        (tester) async {
      final picker = FakeImagePicker(picked: null);
      await tester.pumpWidget(AttachmentRowHarness(picker: picker));
      await tester.pump();

      await tester.tap(find.byIcon(Icons.add));
      await tester.pump();

      expect(picker.pickCalls, 1);
      expect(find.byType(Image), findsNothing);
    });

    testWidgets('upload status overlays reflect each upload state',
        (tester) async {
      Future<void> pumpFor(UploadStatus status) async {
        final job = UploadJobStatus(
          jobId: 'j1',
          status: status,
          progress: status == UploadStatus.done ? 1.0 : 0.25,
        );
        await tester.pumpWidget(AttachmentRowHarness(
          key: ValueKey(status),
          initial: [draft('photo.png')],
          draftToJobId: {pngFile.path: 'j1'},
          uploadStatus: {'j1': job},
          picker: FakeImagePicker(),
        ));
        await tester.pump();
      }

      await pumpFor(UploadStatus.pending);
      expect(
        find.byKey(const ValueKey('attachment-status-pending')),
        findsOneWidget,
      );

      await pumpFor(UploadStatus.uploading);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);

      await pumpFor(UploadStatus.done);
      expect(find.byIcon(Icons.check_circle), findsOneWidget);

      await pumpFor(UploadStatus.failed);
      expect(find.byIcon(Icons.cancel), findsOneWidget);
    });
  });

  group('ChatScreen input bar', () {
    Widget chatApp({required FilesClient filesClient}) {
      return ProviderScope(
        overrides: [
          settingsStoreProvider.overrideWithValue(FakeSettingsStore(
            stored: const BackendSettings(host: 'myhost', secret: 's3cret'),
          )),
          backendProbeProvider.overrideWithValue(FakeProbe()),
          chatStoreProvider.overrideWithValue(FakeChatStore()),
          chatApiClientProvider.overrideWithValue(FakeChatClient()),
          filesServiceProvider.overrideWithValue(filesClient),
        ],
        child: const MaterialApp(home: ChatScreen()),
      );
    }

    testWidgets(
        'hides the attachment picker when the files service is unconfigured',
        (tester) async {
      await tester.pumpWidget(chatApp(filesClient: NoOpFilesClient()));
      await tester.pumpAndSettle();

      expect(find.byType(AttachmentRow), findsNothing);
      expect(find.byIcon(Icons.add), findsNothing);
    });

    testWidgets(
        'shows the attachment add button when the files service is configured',
        (tester) async {
      await tester.pumpWidget(chatApp(filesClient: FakeFilesClient()));
      await tester.pumpAndSettle();

      expect(find.byType(AttachmentRow), findsOneWidget);
      expect(find.byIcon(Icons.add), findsOneWidget);
    });
  });
}