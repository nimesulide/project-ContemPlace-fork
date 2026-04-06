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

  // Telegram connection state
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

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

  async function handleConnectTelegram() {
    setTelegramLoading(true);
    setDeepLink(null);
    try {
      const data = await apiFetch<{ deep_link: string; expires_in_minutes: number }>(
        '/settings/telegram-link',
        { method: 'POST' },
      );
      setDeepLink(data.deep_link);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate Telegram link');
    } finally {
      setTelegramLoading(false);
    }
  }

  async function handleDisconnectTelegram() {
    setDisconnectOpen(false);
    setTelegramLoading(true);
    try {
      await apiFetch('/settings/telegram', { method: 'DELETE' });
      if (profile) {
        setProfile({ ...profile, telegram_connected: false, telegram_chat_id: null });
      }
      setDeepLink(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect Telegram');
    } finally {
      setTelegramLoading(false);
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

      {/* Telegram Connection */}
      <Card>
        <CardContent>
          <Typography variant="h6" gutterBottom>
            Telegram Connection
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Connect your Telegram account to capture notes on the go.
          </Typography>

          {profile.telegram_connected ? (
            <Stack spacing={2}>
              <Typography variant="body2" color="success.main">
                Connected{profile.telegram_chat_id ? ` (Chat ID: ${profile.telegram_chat_id})` : ''}
              </Typography>
              <Box>
                <Button
                  variant="outlined"
                  color="error"
                  onClick={() => setDisconnectOpen(true)}
                  disabled={telegramLoading}
                  startIcon={telegramLoading ? <CircularProgress size={18} /> : undefined}
                >
                  Disconnect
                </Button>
              </Box>
            </Stack>
          ) : (
            <Stack spacing={2}>
              {deepLink ? (
                <>
                  <Typography variant="body2">
                    Open this link to connect your Telegram account:
                  </Typography>
                  <TextField
                    label="Telegram Deep Link"
                    value={deepLink}
                    fullWidth
                    size="small"
                    slotProps={{
                      input: {
                        readOnly: true,
                        endAdornment: (
                          <InputAdornment position="end">
                            <Tooltip title={copied === 'telegram' ? 'Copied!' : 'Copy'}>
                              <IconButton
                                size="small"
                                onClick={() => copyToClipboard(deepLink, 'telegram')}
                              >
                                <ContentCopyIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </InputAdornment>
                        ),
                      },
                    }}
                  />
                  <Button
                    variant="text"
                    href={deepLink}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open in Telegram
                  </Button>
                  <Typography variant="caption" color="text.secondary">
                    This link expires in 15 minutes.
                  </Typography>
                </>
              ) : (
                <Box>
                  <Button
                    variant="contained"
                    onClick={handleConnectTelegram}
                    disabled={telegramLoading}
                    startIcon={telegramLoading ? <CircularProgress size={18} /> : undefined}
                  >
                    Connect Telegram
                  </Button>
                </Box>
              )}
            </Stack>
          )}
        </CardContent>
      </Card>

      {/* Disconnect Telegram confirmation dialog */}
      <Dialog open={disconnectOpen} onClose={() => setDisconnectOpen(false)}>
        <DialogTitle>Disconnect Telegram?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Messages sent to the Telegram bot will no longer be captured under your account.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDisconnectOpen(false)}>Cancel</Button>
          <Button onClick={handleDisconnectTelegram} variant="contained" color="error">
            Disconnect
          </Button>
        </DialogActions>
      </Dialog>

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
