'use client';

import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { apiFetch } from '@/lib/api';

interface Profile {
  user_id: string;
  display_name: string | null;
  email: string | null;
  plan: string;
  has_api_key: boolean;
  mcp_endpoint: string;
  telegram_connected: boolean;
  telegram_chat_id: number | null;
  created_at: string;
}

interface RegenerateKeyResponse {
  api_key: string;
  message: string;
}

export default function SettingsPanel() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // API key state
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [keyLoading, setKeyLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<Profile>('/settings/profile')
      .then(setProfile)
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load profile'),
      )
      .finally(() => setLoading(false));
  }, []);

  async function handleRegenerateKey() {
    setConfirmOpen(false);
    setKeyLoading(true);
    setNewKey(null);
    try {
      const data = await apiFetch<RegenerateKeyResponse>('/settings/regenerate-key', {
        method: 'POST',
      });
      setNewKey(data.api_key);
      setShowKey(true);
      if (profile) {
        setProfile({ ...profile, has_api_key: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate key');
    } finally {
      setKeyLoading(false);
    }
  }

  async function copyToClipboard(text: string, label: string) {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 2000);
  }

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !profile) {
    return (
      <Alert severity="error" sx={{ mb: 2 }}>
        {error}
      </Alert>
    );
  }

  if (!profile) return null;

  return (
    <Stack spacing={3}>
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Profile info */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Profile
          </Typography>
          <Stack spacing={1}>
            <Typography variant="body2" color="text.secondary">
              Email: {profile.email ?? 'N/A'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Display name: {profile.display_name ?? 'N/A'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Plan: {profile.plan}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Member since: {new Date(profile.created_at).toLocaleDateString()}
            </Typography>
          </Stack>
        </CardContent>
      </Card>

      {/* MCP Connection */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            MCP Connection
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Connect any MCP-compatible client using the endpoint and API key below.
          </Typography>

          <Stack spacing={2}>
            <TextField
              label="MCP Endpoint"
              value={profile.mcp_endpoint}
              fullWidth
              size="small"
              slotProps={{
                input: {
                  readOnly: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title={copied === 'endpoint' ? 'Copied!' : 'Copy'}>
                        <IconButton
                          size="small"
                          onClick={() => copyToClipboard(profile.mcp_endpoint, 'endpoint')}
                        >
                          <ContentCopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </InputAdornment>
                  ),
                },
              }}
            />

            {newKey ? (
              <TextField
                label="API Key (save this — it won't be shown again)"
                value={showKey ? newKey : newKey.replace(/./g, '*')}
                fullWidth
                size="small"
                slotProps={{
                  input: {
                    readOnly: true,
                    endAdornment: (
                      <InputAdornment position="end">
                        <Tooltip title={showKey ? 'Hide' : 'Reveal'}>
                          <IconButton
                            size="small"
                            onClick={() => setShowKey(!showKey)}
                          >
                            {showKey ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                          </IconButton>
                        </Tooltip>
                        <Tooltip title={copied === 'key' ? 'Copied!' : 'Copy'}>
                          <IconButton
                            size="small"
                            onClick={() => copyToClipboard(newKey, 'key')}
                          >
                            <ContentCopyIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </InputAdornment>
                    ),
                  },
                }}
              />
            ) : (
              <Typography variant="body2" color="text.secondary">
                API Key: {profile.has_api_key ? 'configured (hidden)' : 'not generated'}
              </Typography>
            )}

            <Box>
              <Button
                variant={profile.has_api_key ? 'outlined' : 'contained'}
                onClick={() => setConfirmOpen(true)}
                disabled={keyLoading}
                startIcon={keyLoading ? <CircularProgress size={18} /> : undefined}
              >
                {profile.has_api_key ? 'Regenerate API Key' : 'Generate API Key'}
              </Button>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      {/* Regenerate key confirmation dialog */}
      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <DialogTitle>
          {profile.has_api_key ? 'Regenerate API Key?' : 'Generate API Key?'}
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            {profile.has_api_key
              ? 'This will immediately invalidate your current API key. Any MCP clients using the old key will stop working until you update them with the new key.'
              : 'This will generate a new API key for your MCP connection. The key will only be shown once — make sure to copy it.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          <Button onClick={handleRegenerateKey} variant="contained" color="primary">
            {profile.has_api_key ? 'Regenerate' : 'Generate'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
