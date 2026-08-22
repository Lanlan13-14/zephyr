package one.zephyr.mobile.contracts

/** Link v2 enrollment paths. Kept beside generated MobileApiPaths so a freeze regen cannot drop them. */
object LinkApiPaths {
    const val POST_ENROLLMENTS: String = "/api/link/v2/enrollments"
    const val GET_ENROLLMENT: String = "/api/link/v2/enrollments/{bindId}"
    const val POST_CONSUME: String = "/api/link/v2/enrollments/{bindId}/consume"
    const val APPROVE_PAGE: String = "/link/approve"

    fun enrollment(bindId: String): String = "/api/link/v2/enrollments/" + bindId

    fun consume(bindId: String): String = "/api/link/v2/enrollments/" + bindId + "/consume"

    fun approve(bindId: String): String = "/link/approve?bindId=" + bindId
}
