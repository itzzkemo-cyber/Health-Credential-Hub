import { useThemeContext } from '../context/ThemeContext';
import colors from '@/constants/colors';

export function useColors() {
  const { isDark } = useThemeContext();
  const palette = isDark && 'dark' in colors ? colors.dark : colors.light;
  return { ...palette, radius: colors.radius };
}
