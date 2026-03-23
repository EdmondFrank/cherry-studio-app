import React from 'react'
import { StyleSheet, View } from 'react-native'

import { TextSelectionProvider } from '@/contexts/TextSelectionContext'
import type { Assistant, Topic } from '@/types/assistant'

import Messages from './messages/Messages'

interface ChatContentProps {
  topic: Topic
  assistant: Assistant
}

const ChatContent = ({ topic, assistant }: ChatContentProps) => {
  return (
    <TextSelectionProvider>
      <View style={styles.container}>
        <Messages assistant={assistant} topic={topic} />
      </View>
    </TextSelectionProvider>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    height: '100%'
  }
})

export default ChatContent
