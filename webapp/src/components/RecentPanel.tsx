'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  Stack,
  Typography,
} from '@mui/material';
import { apiFetch } from '@/lib/api';

interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  created_at: string;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);

  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;

  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;

  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;

  const diffMonth = Math.floor(diffDay / 30);
  return `${diffMonth}mo ago`;
}

export default function RecentPanel() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Note[]>('/recent')
      .then(setNotes)
      .catch((err) =>
        setError(
          err instanceof Error ? err.message : 'Failed to load recent notes',
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        {error}
      </Alert>
    );
  }

  if (notes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
        No notes yet. Capture your first thought!
      </Typography>
    );
  }

  return (
    <Stack spacing={1.5}>
      {notes.map((note) => (
        <Card key={note.id} variant="outlined">
          <CardActionArea
            onClick={() =>
              setExpandedId(expandedId === note.id ? null : note.id)
            }
          >
            <CardContent sx={{ pb: 1 }}>
              <Box
                sx={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  mb: 0.5,
                }}
              >
                <Typography variant="subtitle1" component="div">
                  {note.title}
                </Typography>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{ whiteSpace: 'nowrap', ml: 2 }}
                >
                  {relativeTime(note.created_at)}
                </Typography>
              </Box>
              {note.tags.length > 0 && (
                <Stack
                  direction="row"
                  spacing={0.5}
                  flexWrap="wrap"
                  useFlexGap
                >
                  {note.tags.map((tag) => (
                    <Chip key={tag} label={tag} size="small" variant="outlined" />
                  ))}
                </Stack>
              )}
            </CardContent>
          </CardActionArea>
          <Collapse in={expandedId === note.id}>
            <CardContent sx={{ pt: 0 }}>
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{ whiteSpace: 'pre-wrap' }}
              >
                {note.body}
              </Typography>
            </CardContent>
          </Collapse>
        </Card>
      ))}
    </Stack>
  );
}
