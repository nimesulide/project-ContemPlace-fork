import { Box, Container, Typography } from '@mui/material';
import StatsPanel from '@/components/StatsPanel';
import ClustersPanel from '@/components/ClustersPanel';
import RecentPanel from '@/components/RecentPanel';

export default function DashboardPage() {
  return (
    <Container maxWidth="lg">
      <Typography variant="h4" component="h1" gutterBottom>
        Dashboard
      </Typography>
      <Box sx={{ mb: 4 }}>
        <StatsPanel />
      </Box>
      <Typography variant="h5" component="h2" gutterBottom>
        Clusters
      </Typography>
      <Box sx={{ mb: 4 }}>
        <ClustersPanel />
      </Box>
      <Typography variant="h5" component="h2" gutterBottom>
        Recent notes
      </Typography>
      <RecentPanel />
    </Container>
  );
}
