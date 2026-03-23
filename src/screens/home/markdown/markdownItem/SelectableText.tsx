import type { ReactNode } from 'react'
import React from 'react'
import { Platform, type TextProps, View } from 'react-native'
import { UITextView } from 'react-native-uitextview'
import { withUniwind } from 'uniwind'

import { useTextSelection } from '@/contexts/TextSelectionContext'

const StyledUITextView = withUniwind(UITextView)

interface SelectableTextProps extends TextProps {
  children: ReactNode
}

export function SelectableText({ children, ...props }: SelectableTextProps) {
  const { setIsSelectingText } = useTextSelection()

  return (
    <View
      onTouchStart={() => setIsSelectingText(true)}
      onTouchEnd={() => setTimeout(() => setIsSelectingText(false), 500)}
      onTouchCancel={() => setTimeout(() => setIsSelectingText(false), 500)}>
      <StyledUITextView
        selectable
        uiTextView
        selectionColor={Platform.OS === 'android' ? '#99e2c5' : undefined}
        {...props}>
        {children}
      </StyledUITextView>
    </View>
  )
}
