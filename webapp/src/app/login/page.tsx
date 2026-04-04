'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Box,
  Button,
  Container,
  Divider,
  TextField,
  Typography,
  Alert,
  Stack,
} from '@mui/material';
import { createClient } from '@/lib/supabase/client';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleEmailLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }

    router.push('/app/dashboard');
  }

  async function handleOAuthLogin(provider: 'google' | 'github') {
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: window.location.origin + '/auth/callback',
      },
    });

    if (error) {
      setError(error.message);
    }
  }

  return (
    <Container maxWidth="xs">
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
        }}
      >
        <Typography variant="h4" component="h1" gutterBottom textAlign="center">
          Sign in
        </Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          textAlign="center"
          sx={{ mb: 3 }}
        >
          Welcome back to ContemPlace
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        <Stack spacing={1.5} sx={{ mb: 3 }}>
          <Button
            variant="outlined"
            fullWidth
            onClick={() => handleOAuthLogin('google')}
          >
            Continue with Google
          </Button>
          <Button
            variant="outlined"
            fullWidth
            onClick={() => handleOAuthLogin('github')}
          >
            Continue with GitHub
          </Button>
        </Stack>

        <Divider sx={{ mb: 3 }}>or</Divider>

        <Box component="form" onSubmit={handleEmailLogin}>
          <TextField
            label="Email"
            type="email"
            fullWidth
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            sx={{ mb: 2 }}
          />
          <TextField
            label="Password"
            type="password"
            fullWidth
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            sx={{ mb: 3 }}
          />
          <Button
            type="submit"
            variant="contained"
            fullWidth
            disabled={loading}
            sx={{ mb: 2 }}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </Button>
        </Box>

        <Typography variant="body2" textAlign="center">
          Don&apos;t have an account?{' '}
          <Typography
            component="a"
            href="/signup"
            variant="body2"
            color="primary"
            sx={{ textDecoration: 'none' }}
          >
            Sign up
          </Typography>
        </Typography>
      </Box>
    </Container>
  );
}
