import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useColors } from '@/hooks/useColors';

export function ComplianceBar({ percentage }: { percentage: number }) {
  const colors = useColors();
  
  let color = colors.success;
  if (percentage < 80) color = colors.warning;
  if (percentage < 60) color = colors.destructive;

  return (
    <View style={[styles.container, { backgroundColor: colors.muted }]}>
      <View style={[styles.fill, { width: `${percentage}%`, backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    width: '100%',
  },
  fill: {
    height: '100%',
    borderRadius: 3,
  }
});
