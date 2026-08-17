import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
  View,
} from 'react-native';

export const TV_FOCUS_COLOR = '#3B82F6';

export function TvFocusFrame({
  borderRadius = 12,
  visible,
}: {
  borderRadius?: number;
  visible: boolean;
}) {
  if (!visible) return null;

  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        styles.focusFrame,
        { borderRadius },
      ]}
    />
  );
}

export function TvPressable({
  children,
  focusBorderRadius = 12,
  focusScale = 1.02,
  showFocusFrame = true,
  style,
  onBlur,
  onFocus,
  ...props
}: Omit<PressableProps, 'children' | 'style'> & {
  children: ReactNode | ((focused: boolean) => ReactNode);
  focusBorderRadius?: number;
  focusScale?: number;
  showFocusFrame?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [focused, setFocused] = useState(false);
  const tvFocused = focused && (Platform.isTV || Platform.OS === 'android');

  return (
    <Pressable
      {...props}
      focusable={props.disabled ? false : (props.focusable ?? true)}
      onBlur={(event) => {
        setFocused(false);
        onBlur?.(event);
      }}
      onFocus={(event) => {
        setFocused(true);
        onFocus?.(event);
      }}
      style={({ pressed }) => [
        style,
        pressed ? styles.pressed : null,
        tvFocused ? styles.focused : null,
        tvFocused && focusScale !== 1 ? { transform: [{ scale: focusScale }] } : null,
      ]}
    >
      {typeof children === 'function' ? children(tvFocused) : children}
      {showFocusFrame ? <TvFocusFrame borderRadius={focusBorderRadius} visible={tvFocused} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  focusFrame: {
    borderColor: TV_FOCUS_COLOR,
    borderWidth: 3,
    zIndex: 100,
  },
  focused: {
    elevation: 10,
    shadowColor: TV_FOCUS_COLOR,
    shadowOffset: { height: 0, width: 0 },
    shadowOpacity: 0.48,
    shadowRadius: 9,
    zIndex: 20,
  },
  pressed: {
    opacity: 0.88,
  },
});
