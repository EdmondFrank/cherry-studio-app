import type { ReactNode } from 'react'
import React, { createContext, useContext, useState } from 'react'

interface TextSelectionContextType {
  isSelectingText: boolean
  setIsSelectingText: (value: boolean) => void
}

const TextSelectionContext = createContext<TextSelectionContextType>({
  isSelectingText: false,
  setIsSelectingText: () => {}
})

export function TextSelectionProvider({ children }: { children: ReactNode }) {
  const [isSelectingText, setIsSelectingText] = useState(false)

  return (
    <TextSelectionContext.Provider value={{ isSelectingText, setIsSelectingText }}>
      {children}
    </TextSelectionContext.Provider>
  )
}

export function useTextSelection() {
  return useContext(TextSelectionContext)
}
