import { Container, Typography } from '@mui/material';
import SettingsPanel from '@/components/SettingsPanel';

export default function SettingsPage() {
  return (
    <Container maxWidth="md">
      <Typography variant="h4" component="h1" gutterBottom>
        Settings
      </Typography>
      <SettingsPanel />
    </Container>
  );
}
