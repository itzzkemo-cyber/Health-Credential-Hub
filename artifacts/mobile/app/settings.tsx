import React, { useState } from 'react';
import { View, Text, Switch, ScrollView, StyleSheet, Pressable } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { useLanguage } from '@/context/LanguageContext';
import { useThemeContext } from '@/context/ThemeContext';
import { Ionicons } from '@expo/vector-icons';

export default function SettingsScreen() {
  const colors = useColors();
  const { t, language, setLanguage, isRTL } = useLanguage();
  const { theme, setTheme } = useThemeContext();

  const [alerts, setAlerts] = useState({
    d90: true, d60: true, d30: true, d15: true, d7: true, d1: true
  });

  const SegmentedControl = ({ options, selected, onSelect }: any) => {
    return (
      <View style={[styles.segmentContainer, { backgroundColor: colors.muted }]}>
        {options.map((opt: any) => {
          const isActive = selected === opt.value;
          return (
            <Pressable
              key={opt.value}
              style={[styles.segment, { backgroundColor: isActive ? colors.card : 'transparent' }]}
              onPress={() => onSelect(opt.value)}
            >
              <Text style={{ color: isActive ? colors.foreground : colors.mutedForeground, fontWeight: isActive ? 'bold' : 'normal' }}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  };

  const Section = ({ title, children }: any) => (
    <View style={{ marginBottom: 24 }}>
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground, textAlign: isRTL ? 'right' : 'left' }]}>{title}</Text>
      <View style={[styles.sectionCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        {children}
      </View>
    </View>
  );

  const Row = ({ label, children, border = true }: any) => (
    <View style={[styles.row, { borderBottomWidth: border ? 1 : 0, borderBottomColor: colors.border, flexDirection: isRTL ? 'row-reverse' : 'row' }]}>
      <Text style={[styles.rowLabel, { color: colors.foreground, textAlign: isRTL ? 'right' : 'left' }]}>{label}</Text>
      {children}
    </View>
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.background }} contentContainerStyle={{ padding: 20, paddingBottom: 60 }}>
      
      <Section title={t('settings.language')}>
        <View style={{ padding: 16 }}>
          <SegmentedControl 
            options={[{ label: 'العربية', value: 'ar' }, { label: 'English', value: 'en' }]}
            selected={language}
            onSelect={setLanguage}
          />
        </View>
      </Section>

      <Section title={t('settings.theme')}>
        <View style={{ padding: 16 }}>
          <SegmentedControl 
            options={[
              { label: t('settings.light'), value: 'light' },
              { label: t('settings.dark'), value: 'dark' },
              { label: t('settings.system'), value: 'system' }
            ]}
            selected={theme}
            onSelect={setTheme}
          />
        </View>
      </Section>

      <Section title={t('settings.alerts')}>
        <Row label={t('settings.days90')}>
          <Switch value={alerts.d90} onValueChange={v => setAlerts(p => ({...p, d90: v}))} trackColor={{ true: colors.primary }} />
        </Row>
        <Row label={t('settings.days30')}>
          <Switch value={alerts.d30} onValueChange={v => setAlerts(p => ({...p, d30: v}))} trackColor={{ true: colors.primary }} />
        </Row>
        <Row label={t('settings.days7')}>
          <Switch value={alerts.d7} onValueChange={v => setAlerts(p => ({...p, d7: v}))} trackColor={{ true: colors.primary }} />
        </Row>
        <Row label={t('settings.days1')} border={false}>
          <Switch value={alerts.d1} onValueChange={v => setAlerts(p => ({...p, d1: v}))} trackColor={{ true: colors.primary }} />
        </Row>
      </Section>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    fontSize: 14,
    fontWeight: 'bold',
    marginBottom: 8,
    textTransform: 'uppercase',
    paddingHorizontal: 8,
  },
  sectionCard: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  row: {
    padding: 16,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  rowLabel: {
    fontSize: 16,
    flex: 1,
  },
  segmentContainer: {
    flexDirection: 'row',
    borderRadius: 8,
    padding: 4,
  },
  segment: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 6,
  }
});
