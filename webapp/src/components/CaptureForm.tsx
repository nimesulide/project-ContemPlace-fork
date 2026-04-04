'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { apiFetch } from '@/lib/api';

interface CaptureResult {
  id: string;
  title: string;
  body: string;
  tags: string[];
}

export default function CaptureForm() {
  const router = useRouter();
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureResult | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim()) return;

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const data = await apiFetch<CaptureResult>('/capture', {
        method: 'POST',
        body: JSON.stringify({ text: input, source: 'web' }),
      });
      setResult(data);
      setInput('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Capture failed';
      if (message === 'Not authenticated' || message === 'Session expired') {
        router.push('/login');
        return;
      }
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Box>
      <Box component="form" onSubmit={handleSubmit}>
        <TextField
          label="What's on your mind?"
          multiline
          minRows={4}
          maxRows={12}
          fullWidth
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={loading}
          sx={{ mb: 2 }}
        />
        <Button
          type="submit"
          variant="contained"
          disabled={loading || !input.trim()}
          startIcon={loading ? <CircularProgress size={18} /> : undefined}
        >
          {loading ? 'Capturing...' : 'Capture'}
        </Button>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {result && (
        <Card sx={{ mt: 3 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              {result.title}
            </Typography>
            <Typography variant="body1" sx={{ mb: 2, whiteSpace: 'pre-wrap' }}>
              {result.body}
            </Typography>
            {result.tags.length > 0 && (
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {result.tags.map((tag) => (
                  <Chip key={tag} label={tag} size="small" />
                ))}
              </Stack>
            )}
            <Button
              href="/app/dashboard"
              variant="text"
              size="small"
              sx={{ mt: 2 }}
            >
              View Dashboard
            </Button>
          </CardContent>
        </Card>
      )}
    </Box>
  );
}
