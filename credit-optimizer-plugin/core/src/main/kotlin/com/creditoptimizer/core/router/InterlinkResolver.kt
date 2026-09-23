package com.creditoptimizer.core.router

import com.creditoptimizer.core.model.MessagingDirection
import com.creditoptimizer.core.model.MessagingInterlinkFact
import com.creditoptimizer.core.model.ServiceIndex

/**
 * Computes real cross-repo edges from the full set of loaded indexes —
 * as opposed to a plain "channel name contains X" filter, which reads as
 * cross-repo but is really just search. A [MessagingInterlinkFact] is an
 * actual producer/consumer pair: same channel (case-insensitive), same
 * broker, in two *different* services. A same-service producer/consumer
 * pair (a service reacting to its own message) is never reported — that's
 * not a cross-repo link.
 */
object InterlinkResolver {

    fun messagingInterlinks(indexes: List<ServiceIndex>): List<MessagingInterlinkFact> {
        val producers = indexes.flatMap { it.messaging }.filter { it.direction == MessagingDirection.PRODUCER }
        val consumers = indexes.flatMap { it.messaging }.filter { it.direction == MessagingDirection.CONSUMER }

        val links = mutableListOf<MessagingInterlinkFact>()
        for (producer in producers) {
            for (consumer in consumers) {
                if (producer.service == consumer.service) continue
                if (!producer.channel.equals(consumer.channel, ignoreCase = true)) continue
                if (!producer.broker.equals(consumer.broker, ignoreCase = true)) continue
                links += MessagingInterlinkFact(producer, consumer)
            }
        }
        return links
    }
}
