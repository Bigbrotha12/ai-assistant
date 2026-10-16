import 'package:flutter/material.dart';

/// Shared status presentation for the goal surfaces — one mapping used by both
/// the todo view and the goals overlay, so a status never reads differently in
/// two places.

String goalStatusLabel(String status) => switch (status) {
  'queued' => 'Queued',
  'running' => 'Running',
  'paused' => 'Paused',
  'complete' => 'Complete',
  'failed' => 'Failed',
  'cancelled' => 'Cancelled',
  _ => status,
};

IconData goalStatusIcon(String status) => switch (status) {
  'running' => Icons.timelapse,
  'paused' => Icons.pause_circle_outline,
  'complete' => Icons.check_circle,
  'failed' => Icons.error_outline,
  'cancelled' => Icons.block,
  _ => Icons.schedule,
};

Color goalStatusColor(String status, ColorScheme scheme) => switch (status) {
  'running' => scheme.primary,
  'paused' => scheme.tertiary,
  'complete' => scheme.primary,
  'failed' => scheme.error,
  _ => scheme.onSurfaceVariant,
};
