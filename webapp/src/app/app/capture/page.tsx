import { Container, Typography } from '@mui/material';
import CaptureForm from '@/components/CaptureForm';

export default function CapturePage() {
  return (
    <Container maxWidth="md">
      <Typography variant="h4" component="h1" gutterBottom>
        Capture a thought
      </Typography>
      <CaptureForm />
    </Container>
  );
}
