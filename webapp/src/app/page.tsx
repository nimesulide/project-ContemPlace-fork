import { Box, Button, Container, Stack, Typography } from '@mui/material';

export default function LandingPage() {
  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          textAlign: 'center',
        }}
      >
        <Typography variant="h3" component="h1" gutterBottom fontWeight={700}>
          ContemPlace
        </Typography>
        <Typography
          variant="h6"
          color="text.secondary"
          sx={{ mb: 4, maxWidth: 400 }}
        >
          Your personal knowledge garden. Capture ideas, let the system connect
          them.
        </Typography>
        <Stack direction="row" spacing={2}>
          <Button variant="contained" size="large" href="/login">
            Sign in
          </Button>
          <Button variant="outlined" size="large" href="/signup">
            Sign up
          </Button>
        </Stack>
      </Box>
    </Container>
  );
}
