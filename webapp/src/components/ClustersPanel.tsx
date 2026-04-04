'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { apiFetch } from '@/lib/api';

interface HubNote {
  id: string;
  title: string;
  link_count: number;
}

interface ClusterCard {
  label: string;
  top_tags: string[];
  note_count: number;
  gravity: number;
  note_ids: string[];
  hub_notes: HubNote[];
}

interface ClustersResponse {
  resolution: number;
  available_resolutions: number[];
  clusters: ClusterCard[];
}

export default function ClustersPanel() {
  const [data, setData] = useState<ClustersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<number>(1.0);

  const fetchClusters = useCallback((res: number) => {
    setLoading(true);
    setError(null);
    apiFetch<ClustersResponse>(`/clusters?resolution=${res}`)
      .then((result) => {
        setData(result);
        // If this is the first load and 1.0 isn't available, use the first available
        if (result.available_resolutions.length > 0 && !result.available_resolutions.includes(res)) {
          const fallback = result.available_resolutions[0];
          setResolution(fallback);
          // Re-fetch with the correct resolution
          apiFetch<ClustersResponse>(`/clusters?resolution=${fallback}`)
            .then(setData)
            .catch(() => {
              // Keep the original result on fallback failure
            });
        }
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : 'Failed to load clusters'),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchClusters(resolution);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleResolutionChange = (_: React.MouseEvent<HTMLElement>, newRes: number | null) => {
    if (newRes === null) return; // don't allow deselect
    setResolution(newRes);
    fetchClusters(newRes);
  };

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

  if (!data) return null;

  const showResolutionSelector = data.available_resolutions.length > 1;

  return (
    <Box>
      {showResolutionSelector && (
        <Box sx={{ mb: 2 }}>
          <ToggleButtonGroup
            value={resolution}
            exclusive
            onChange={handleResolutionChange}
            size="small"
          >
            {data.available_resolutions.map((res) => (
              <ToggleButton key={res} value={res}>
                {res}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        </Box>
      )}

      {data.clusters.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
          No clusters yet. Clusters appear after the gardening pipeline runs.
        </Typography>
      ) : (
        <Stack spacing={2}>
          {data.clusters.map((cluster) => (
            <Card key={cluster.label} variant="outlined">
              <CardContent>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                  <Typography variant="h6" component="div">
                    {cluster.label}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap', ml: 2 }}>
                    {cluster.note_count} {cluster.note_count === 1 ? 'note' : 'notes'}
                  </Typography>
                </Box>

                {cluster.top_tags.length > 0 && (
                  <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
                    {cluster.top_tags.map((tag) => (
                      <Chip key={tag} label={tag} size="small" variant="outlined" />
                    ))}
                  </Stack>
                )}

                {cluster.hub_notes.length > 0 && (
                  <Box sx={{ mt: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      Hub notes
                    </Typography>
                    {cluster.hub_notes.map((hub) => (
                      <Typography key={hub.id} variant="body2" sx={{ pl: 1 }}>
                        {hub.title}
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                          ({hub.link_count} {hub.link_count === 1 ? 'link' : 'links'})
                        </Typography>
                      </Typography>
                    ))}
                  </Box>
                )}
              </CardContent>
            </Card>
          ))}
        </Stack>
      )}
    </Box>
  );
}
