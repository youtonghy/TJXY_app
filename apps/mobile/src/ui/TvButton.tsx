import { Button as HeroButton, type ButtonRootProps } from 'heroui-native/button';
import { Platform } from 'react-native';
import { useState } from 'react';
import { TvFocusFrame } from './TvPressable';

type TvButtonProps = ButtonRootProps & {
  focusBorderRadius?: number;
};

function TvButtonRoot({
  children,
  focusBorderRadius = 999,
  focusable,
  isDisabled,
  onBlur,
  onFocus,
  ...props
}: TvButtonProps) {
  const [focused, setFocused] = useState(false);
  const showFocus = focused && (Platform.isTV || Platform.OS === 'android');

  return (
    <HeroButton
      {...props}
      focusable={isDisabled ? false : (focusable ?? true)}
      isDisabled={isDisabled}
      onBlur={(event) => {
        setFocused(false);
        if (typeof onBlur === 'function') onBlur(event);
      }}
      onFocus={(event) => {
        setFocused(true);
        if (typeof onFocus === 'function') onFocus(event);
      }}
    >
      {children}
      <TvFocusFrame borderRadius={focusBorderRadius} visible={showFocus} />
    </HeroButton>
  );
}

export const TvButton = Object.assign(TvButtonRoot, {
  Background: HeroButton.Background,
  Label: HeroButton.Label,
});
